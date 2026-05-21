/**
 * Server-derived relative cost pricing.
 * Base currency is chosen dynamically from live vending data each refresh.
 * Values are resolved via reliable exchange edges (direct or multi-hop, max depth 5).
 * When confidence or connectivity is insufficient, relative cost is null — never guessed.
 */

const SCRAP_ITEM_ID_FALLBACK = -932201673;
const HQM_ITEM_ID = 317398316;
const MAX_PATH_DEPTH = 5;
const MIN_SAMPLES = 2;
const MIN_MACHINES = 2;
const MIN_SAMPLES_LOOSE = 1;
const MIN_MACHINES_LOOSE = 1;
/** Total relative cost below this is unknown (junk graph paths / noise). */
const MIN_RELATIVE_COST = 0.01;
/** Per-item can be much smaller for bulk stacks (e.g. 10k sulfur ore). */
const MIN_RELATIVE_UNIT = 1e-6;

// #region agent log
function agentLog(hypothesisId, location, message, data, runId = 'pre-fix') {
  fetch('http://127.0.0.1:7369/ingest/44f44534-d7e5-450d-8927-d2fac007dc43', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '77abd7' },
    body: JSON.stringify({
      sessionId: '77abd7',
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
      runId
    })
  }).catch(() => {});
}
// #endregion

function resolveScrapItemId(itemNames) {
  if (!itemNames || typeof itemNames !== 'object') {
    return SCRAP_ITEM_ID_FALLBACK;
  }
  for (const [id, entry] of Object.entries(itemNames)) {
    if (!entry) continue;
    if (entry.short === 'scrap' || entry.name === 'Scrap') {
      return parseInt(id, 10);
    }
  }
  return SCRAP_ITEM_ID_FALLBACK;
}

function getItemName(itemNames, itemId) {
  const entry = itemNames?.[String(itemId)];
  return entry?.name || `Item ${itemId}`;
}

function median(values) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function isValidNumber(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function isValidBaseValue(resolved) {
  return resolved != null && isValidNumber(resolved.baseValue);
}

function isValidRelativeCost(value) {
  return isValidNumber(value) && value >= MIN_RELATIVE_COST;
}

function isValidRelativeUnit(value) {
  return isValidNumber(value) && value >= MIN_RELATIVE_UNIT;
}

function isValidOffer(order) {
  if (!order) return false;
  const quantity = order.quantity;
  const costPerItem = order.costPerItem;
  if (!Number.isFinite(quantity) || quantity <= 0) return false;
  if (!Number.isFinite(costPerItem) || costPerItem <= 0) return false;
  if (!Number.isFinite(order.itemId) || !Number.isFinite(order.currencyId)) return false;
  return true;
}

/** Rust+ SellOrder: costPerItem is payment currency per one sold item; quantity is stack size. */
function paymentPerItem(offer) {
  return offer.costPerItem;
}

/**
 * Total payment for the listing — always costPerItem (same as UI Cost Qty).
 * Item qty only affects Cost (Each), not total payment.
 */
function totalPaymentForOffer(offer) {
  const pay = paymentPerItem(offer);
  if (!Number.isFinite(pay)) return NaN;
  return pay;
}

/** @deprecated alias */
function totalPaymentInCurrency(offer) {
  return totalPaymentForOffer(offer);
}

/** Payment per sold item (matches UI Cost (Each) = costPerItem / item qty). */
function paymentPerSoldItemEach(offer) {
  return paymentPerItem(offer) / offer.quantity;
}

function normalizeItemId(id) {
  const n = Number(id);
  return Number.isFinite(n) ? n : id;
}

function edgeKey(soldId, currencyId) {
  return `${normalizeItemId(soldId)}:${normalizeItemId(currencyId)}`;
}

/**
 * Rust+ markers often lack unique ids (0 or missing). Use position/name as shop identity.
 */
function getMachineKey(machine) {
  const id = machine?.id;
  if (id != null && id !== 0 && id !== '0') {
    return `id:${id}`;
  }
  const x = machine?.x;
  const y = machine?.y;
  if (Number.isFinite(x) && Number.isFinite(y)) {
    return `pos:${Math.round(x)}:${Math.round(y)}`;
  }
  if (machine?.name) {
    return `name:${machine.name}`;
  }
  return null;
}

function flattenOffers(machines) {
  const offers = [];
  for (const machine of machines || []) {
    const machineKey = getMachineKey(machine);
    for (const order of machine?.sellOrders || []) {
      offers.push({
        ...order,
        itemId: normalizeItemId(order.itemId),
        currencyId: normalizeItemId(order.currencyId),
        machineId: machine?.id,
        machineKey
      });
    }
  }
  return offers;
}

function passesConfidenceGate(sampleCount, uniqueMachineCount, min, max, med) {
  if (sampleCount < MIN_SAMPLES) return false;
  if (uniqueMachineCount < MIN_MACHINES) return false;
  if (!isValidNumber(med)) return false;
  if (!isValidNumber(min) || !isValidNumber(max)) return false;
  if (max > med * 3 && sampleCount < 10) return false;
  return true;
}

function collectItemCurrencyRateBuckets(offers) {
  const buckets = new Map();

  for (const offer of offers || []) {
    if (!isValidOffer(offer)) continue;
    const unitRate = paymentPerSoldItemEach(offer);
    if (!isValidNumber(unitRate)) continue;

    const key = edgeKey(offer.itemId, offer.currencyId);
    if (!buckets.has(key)) {
      buckets.set(key, {
        soldId: offer.itemId,
        currencyId: offer.currencyId,
        rates: [],
        machineIds: new Set()
      });
    }
    const bucket = buckets.get(key);
    bucket.rates.push(unitRate);
    if (offer.machineKey) {
      bucket.machineIds.add(offer.machineKey);
    }
  }

  return buckets;
}

function bucketsToEdges(buckets, minSamples, minMachines, skipSpreadCheck = false) {
  const edges = new Map();
  const rejectReasons = { samples: 0, machines: 0, spread: 0, invalid: 0 };

  for (const [key, bucket] of buckets) {
    const sampleCount = bucket.rates.length;
    const uniqueMachineCount = bucket.machineIds.size || (sampleCount > 0 ? 1 : 0);
    const min = Math.min(...bucket.rates);
    const max = Math.max(...bucket.rates);
    const med = median(bucket.rates);

    if (sampleCount < minSamples) { rejectReasons.samples++; continue; }
    if (uniqueMachineCount < minMachines) { rejectReasons.machines++; continue; }
    if (!isValidNumber(med) || !isValidNumber(min) || !isValidNumber(max)) {
      rejectReasons.invalid++;
      continue;
    }
    if (!skipSpreadCheck && max > med * 3 && sampleCount < 10) { rejectReasons.spread++; continue; }

    edges.set(key, {
      soldId: bucket.soldId,
      currencyId: bucket.currencyId,
      medianRate: med,
      sampleCount,
      confidence: sampleCount >= 10 ? 'high' : 'medium',
      uniqueMachineCount
    });
  }

  return { edges, rejectReasons, bucketCount: buckets.size };
}

/**
 * Build reliable direct exchange edges: sold A -> payment B at median unit rate.
 */
function buildReliableExchangeEdges(offers) {
  const buckets = collectItemCurrencyRateBuckets(offers);
  const { edges, rejectReasons, bucketCount } = bucketsToEdges(
    buckets,
    MIN_SAMPLES,
    MIN_MACHINES
  );

  // #region agent log
  agentLog('B', 'market-rates.js:buildReliableExchangeEdges', 'forward edge build summary', {
    bucketCount,
    acceptedEdges: edges.size,
    rejectReasons,
    minSamples: MIN_SAMPLES
  });
  // #endregion

  return edges;
}

/**
 * Looser per-item rates for cross-currency inference (2 offers, 1 shop).
 */
function buildLooseItemCurrencyRates(offers) {
  const buckets = collectItemCurrencyRateBuckets(offers);
  const { edges } = bucketsToEdges(buckets, MIN_SAMPLES_LOOSE, MIN_MACHINES_LOOSE, true);
  return edges;
}

const MIN_BRIDGE_ITEMS = 1;
const MIN_BRIDGE_EDGE_SAMPLES = 1;

/**
 * Infer currency -> base from items listed in BOTH scrap and another currency (raw offers).
 * One shared item (e.g. sulfur) is enough when each leg has 2+ listings.
 */
function buildImpliedCurrencyToBaseEdgesFromOffers(offers, baseId) {
  const itemCurrency = new Map();

  for (const offer of offers || []) {
    if (!isValidOffer(offer)) continue;
    const itemId = normalizeItemId(offer.itemId);
    const currencyId = normalizeItemId(offer.currencyId);
    const unitRate = paymentPerSoldItemEach(offer);
    if (!isValidNumber(unitRate)) continue;

    if (!itemCurrency.has(itemId)) itemCurrency.set(itemId, new Map());
    const curMap = itemCurrency.get(itemId);
    if (!curMap.has(currencyId)) {
      curMap.set(currencyId, { rates: [], machineIds: new Set() });
    }
    const bucket = curMap.get(currencyId);
    bucket.rates.push(unitRate);
    if (offer.machineKey) bucket.machineIds.add(offer.machineKey);
  }

  const impliedRates = new Map();

  for (const [, curMap] of itemCurrency) {
    const baseBucket = curMap.get(baseId);
    if (!baseBucket || baseBucket.rates.length < MIN_BRIDGE_EDGE_SAMPLES) continue;
    const baseMed = median(baseBucket.rates);
    if (!isValidNumber(baseMed)) continue;

    for (const [currencyId, bucket] of curMap) {
      if (currencyId === baseId || bucket.rates.length < MIN_BRIDGE_EDGE_SAMPLES) continue;

      const curMed = median(bucket.rates);
      const rateToBase = baseMed / curMed;
      if (!isValidNumber(rateToBase)) continue;

      if (!impliedRates.has(currencyId)) impliedRates.set(currencyId, []);
      impliedRates.get(currencyId).push(rateToBase);
    }
  }

  const implied = new Map();
  for (const [currencyId, rates] of impliedRates) {
    if (rates.length < MIN_BRIDGE_ITEMS) continue;

    const min = Math.min(...rates);
    const max = Math.max(...rates);
    const med = median(rates);

    if (!isValidNumber(med)) continue;
    if (!isValidNumber(min) || !isValidNumber(max)) continue;
    if (max > med * 3 && rates.length < 3) continue;

    implied.set(edgeKey(currencyId, baseId), {
      soldId: currencyId,
      currencyId: baseId,
      medianRate: med,
      sampleCount: rates.length,
      confidence: rates.length >= 4 ? 'high' : 'medium',
      uniqueMachineCount: rates.length,
      isImplied: true
    });
  }

  return implied;
}

/**
 * Infer currency -> base rates from pre-built item rate edges (legacy path).
 */
function buildImpliedCurrencyToBaseEdges(itemRateEdges, baseId) {
  const bySold = new Map();
  for (const edge of itemRateEdges.values()) {
    const soldId = normalizeItemId(edge.soldId);
    if (!bySold.has(soldId)) bySold.set(soldId, []);
    bySold.get(soldId).push(edge);
  }

  const impliedRates = new Map();

  for (const itemEdges of bySold.values()) {
    const baseEdge = itemEdges.find(e => normalizeItemId(e.currencyId) === baseId);
    if (!baseEdge || baseEdge.sampleCount < MIN_BRIDGE_EDGE_SAMPLES) continue;

    for (const edge of itemEdges) {
      const currencyId = normalizeItemId(edge.currencyId);
      if (currencyId === baseId || edge.sampleCount < MIN_BRIDGE_EDGE_SAMPLES) continue;

      const rateToBase = baseEdge.medianRate / edge.medianRate;
      if (!isValidNumber(rateToBase)) continue;

      if (!impliedRates.has(currencyId)) impliedRates.set(currencyId, []);
      impliedRates.get(currencyId).push(rateToBase);
    }
  }

  const implied = new Map();
  for (const [currencyId, rates] of impliedRates) {
    if (rates.length < MIN_BRIDGE_ITEMS) continue;

    const min = Math.min(...rates);
    const max = Math.max(...rates);
    const med = median(rates);

    if (!isValidNumber(med)) continue;
    if (!isValidNumber(min) || !isValidNumber(max)) continue;
    if (max > med * 3 && rates.length < 3) continue;

    implied.set(edgeKey(currencyId, baseId), {
      soldId: currencyId,
      currencyId: baseId,
      medianRate: med,
      sampleCount: rates.length,
      confidence: rates.length >= 4 ? 'high' : 'medium',
      uniqueMachineCount: rates.length,
      isImplied: true
    });
  }

  return implied;
}

function mergeEdgeMaps(forwardEdges, impliedEdges) {
  const merged = new Map(forwardEdges);
  for (const [key, edge] of impliedEdges) {
    if (!merged.has(key)) {
      merged.set(key, edge);
    }
  }
  return merged;
}

/**
 * Score payment items for base currency candidacy.
 */
function scorePaymentItems(offers) {
  const scores = new Map();

  for (const offer of offers || []) {
    if (!isValidOffer(offer)) continue;
    const currencyId = offer.currencyId;

    if (!scores.has(currencyId)) {
      scores.set(currencyId, {
        itemId: currencyId,
        paymentOfferCount: 0,
        machineIds: new Set(),
        connectedItems: new Set()
      });
    }
    const s = scores.get(currencyId);
    s.paymentOfferCount += 1;
    if (offer.machineKey) s.machineIds.add(offer.machineKey);
    s.connectedItems.add(offer.itemId);
  }

  const result = [];
  for (const s of scores.values()) {
    const uniqueMachineCount = s.machineIds.size || (s.paymentOfferCount > 0 ? 1 : 0);
    const connectedItemCount = s.connectedItems.size;
    const baseScore = s.paymentOfferCount + uniqueMachineCount * 2 + connectedItemCount;
    result.push({
      itemId: s.itemId,
      paymentOfferCount: s.paymentOfferCount,
      uniqueMachineCount,
      connectedItemCount,
      baseScore
    });
  }

  return result;
}

/**
 * Select base currency: always the most liquid payment item (highest baseScore).
 */
function selectBaseCurrency(offers, scrapItemId) {
  const scores = scorePaymentItems(offers);
  if (!scores.length) {
    return {
      itemId: scrapItemId,
      baseScore: 0,
      paymentOfferCount: 0,
      uniqueMachineCount: 0,
      connectedItemCount: 0,
      selectedBecause: 'fallback'
    };
  }

  const scrapNorm = normalizeItemId(scrapItemId);
  let best = scores.reduce((a, b) => {
    if (b.baseScore > a.baseScore) return b;
    if (b.baseScore < a.baseScore) return a;
    if (b.paymentOfferCount > a.paymentOfferCount) return b;
    if (b.paymentOfferCount < a.paymentOfferCount) return a;
    if (b.uniqueMachineCount > a.uniqueMachineCount) return b;
    if (b.uniqueMachineCount < a.uniqueMachineCount) return a;
    const aScrap = normalizeItemId(a.itemId) === scrapNorm;
    const bScrap = normalizeItemId(b.itemId) === scrapNorm;
    if (bScrap && !aScrap) return b;
    if (aScrap && !bScrap) return a;
    return b.connectedItemCount > a.connectedItemCount ? b : a;
  });

  let selectedBecause = 'highest-score';
  const scrapEntry = scores.find(s => normalizeItemId(s.itemId) === scrapNorm);
  if (
    scrapEntry &&
    normalizeItemId(best.itemId) !== scrapNorm &&
    best.baseScore <= scrapEntry.baseScore * 1.15
  ) {
    best = scrapEntry;
    selectedBecause = 'scrap-near-tie';
  }

  return {
    itemId: best.itemId,
    baseScore: best.baseScore,
    paymentOfferCount: best.paymentOfferCount,
    uniqueMachineCount: best.uniqueMachineCount,
    connectedItemCount: best.connectedItemCount,
    selectedBecause
  };
}

/**
 * Adjacency list with forward and reverse edges.
 * Forward: sold A for B at rate r => 1 A costs r B (walk A -> B, multiply by r).
 * Reverse: same listing => 1 B costs 1/r A (walk B -> A, multiply by 1/r).
 * Reverse edges are required when a currency is common as payment but rarely sold directly.
 */
function buildAdjacency(edges) {
  const adj = new Map();

  const addEdge = (fromId, toId, rate, sampleCount, confidence) => {
    if (!isValidNumber(rate)) return;
    if (!adj.has(fromId)) adj.set(fromId, []);
    adj.get(fromId).push({
      currencyId: toId,
      rate,
      sampleCount,
      confidence
    });
  };

  for (const edge of edges.values()) {
    addEdge(
      edge.soldId,
      edge.currencyId,
      edge.medianRate,
      edge.sampleCount,
      edge.confidence
    );
    addEdge(
      edge.currencyId,
      edge.soldId,
      1 / edge.medianRate,
      edge.sampleCount,
      edge.confidence
    );
  }

  return adj;
}

function weakerConfidence(a, b) {
  if (a === 'high' && b === 'high') return 'high';
  if (a === 'medium' || b === 'medium') return 'medium';
  return a || b;
}

/**
 * Cheapest multiplicative path from item to base (units of base per 1 unit of item).
 */
function resolveToBase(itemId, baseId, edges, maxDepth = MAX_PATH_DEPTH) {
  if (itemId === baseId) {
    return { baseValue: 1, pathDepth: 0, confidence: 'high', sampleCount: null };
  }

  const adj = buildAdjacency(edges);
  const dist = new Map();
  const pq = [{ id: itemId, cost: 1, depth: 0, confidence: 'high', sampleCount: null }];

  while (pq.length > 0) {
    pq.sort((a, b) => a.cost - b.cost);
    const { id, cost, depth, confidence, sampleCount } = pq.shift();

    if (depth > maxDepth) continue;
    if (dist.has(id) && cost > dist.get(id)) continue;
    dist.set(id, cost);

    if (id === baseId) {
      if (!isValidNumber(cost)) return null;
      return { baseValue: cost, pathDepth: depth, confidence, sampleCount };
    }

    for (const { currencyId, rate, sampleCount: edgeSamples, confidence: edgeConf } of adj.get(id) || []) {
      const nextCost = cost * rate;
      if (!isValidNumber(nextCost)) continue;
      if (dist.has(currencyId) && nextCost >= dist.get(currencyId)) continue;

      const nextConf = weakerConfidence(confidence, edgeConf);
      const nextSample = sampleCount == null ? edgeSamples : Math.min(sampleCount, edgeSamples);
      pq.push({
        id: currencyId,
        cost: nextCost,
        depth: depth + 1,
        confidence: nextConf,
        sampleCount: nextSample
      });
    }
  }

  return null;
}

/**
 * Cache base-equivalent values for all items seen in offers.
 */
function buildBaseValueCache(offers, baseId, edges) {
  const itemIds = new Set();
  for (const offer of offers || []) {
    if (!isValidOffer(offer)) continue;
    itemIds.add(normalizeItemId(offer.itemId));
    itemIds.add(normalizeItemId(offer.currencyId));
  }

  const cache = new Map();
  for (const id of itemIds) {
    const resolved = resolveToBase(id, baseId, edges);
    cache.set(id, isValidBaseValue(resolved) ? resolved : null);
  }
  return cache;
}

/**
 * Items listed directly for the base currency (e.g. sulfur ore for scrap).
 */
function refineSoldItemBaseValueFromBaseListings(offers, baseId, cache) {
  const baseNorm = normalizeItemId(baseId);
  const pending = new Map();

  for (const offer of offers || []) {
    if (!isValidOffer(offer)) continue;
    if (normalizeItemId(offer.currencyId) !== baseNorm) continue;

    const itemId = normalizeItemId(offer.itemId);
    const unitBase = paymentPerSoldItemEach(offer);
    if (!isValidNumber(unitBase)) continue;

    if (!pending.has(itemId)) pending.set(itemId, []);
    pending.get(itemId).push(unitBase);
  }

  for (const [itemId, rates] of pending) {
    if (rates.length < MIN_SAMPLES_LOOSE) continue;

    const min = Math.min(...rates);
    const max = Math.max(...rates);
    const med = median(rates);
    if (!isValidNumber(med)) continue;
    if (max > med * 3 && rates.length < 3) continue;

    const existing = cache.get(itemId);
    if (existing?.viaSoldItems && isValidBaseValue(existing)) continue;
    if (existing?.viaDirectListing && isValidBaseValue(existing)) continue;

    cache.set(itemId, {
      baseValue: med,
      pathDepth: 0,
      confidence: rates.length >= 10 ? 'high' : 'medium',
      sampleCount: rates.length,
      viaDirectListing: true
    });
  }

  return cache;
}

/**
 * Infer payment-currency value from listings where the sold item already resolves to base.
 * Example: charcoal priced in MF + charcoal known in scrap => MF scrap rate without MF in graph.
 */
function refinePaymentCurrencyCacheFromSoldItems(offers, baseId, cache, maxPasses = 3) {
  const baseNorm = normalizeItemId(baseId);

  for (let pass = 0; pass < maxPasses; pass++) {
    const pending = new Map();

    for (const offer of offers || []) {
      if (!isValidOffer(offer)) continue;
      const currencyId = normalizeItemId(offer.currencyId);
      if (currencyId === baseNorm) continue;

      const existing = cache.get(currencyId);
      if (existing?.viaSoldItems && isValidBaseValue(existing)) continue;

      const itemId = normalizeItemId(offer.itemId);
      const itemResolved = cache.get(itemId);
      if (!isValidBaseValue(itemResolved)) continue;

      const totalPay = totalPaymentForOffer(offer);
      if (!isValidNumber(totalPay)) continue;

      const valueReceivedInBase = itemResolved.baseValue * offer.quantity;
      const basePerPayment = valueReceivedInBase / totalPay;
      if (!isValidNumber(basePerPayment)) continue;

      if (!pending.has(currencyId)) pending.set(currencyId, []);
      pending.get(currencyId).push({
        rate: basePerPayment,
        depth: (itemResolved.pathDepth ?? 0) + 1,
        sampleCount: itemResolved.sampleCount,
        confidence: itemResolved.confidence
      });
    }

    let changed = false;
    for (const [currencyId, entries] of pending) {
      if (entries.length < MIN_BRIDGE_EDGE_SAMPLES) continue;

      const rates = entries.map(e => e.rate);
      const min = Math.min(...rates);
      const max = Math.max(...rates);
      const med = median(rates);
      if (!isValidNumber(med)) continue;
      if (max > med * 3 && rates.length < 3) continue;

      const depths = entries.map(e => e.depth);
      const pathDepth = Math.min(Math.max(...depths), MAX_PATH_DEPTH);
      const sampleCount = Math.min(...entries.map(e => e.sampleCount ?? Infinity));
      const confidences = entries.map(e => e.confidence);
      const confidence = confidences.includes('high')
        ? 'high'
        : confidences.includes('medium')
          ? 'medium'
          : 'low';

      cache.set(currencyId, {
        baseValue: med,
        pathDepth,
        confidence,
        sampleCount: Number.isFinite(sampleCount) ? sampleCount : entries.length,
        viaSoldItems: true
      });
      changed = true;
    }

    if (!changed) break;
  }

  return cache;
}

/**
 * Value a currency/item from shops that sell it (ask price): e.g. CCTV for 500 sulfur ore.
 */
function refineCurrencyValueFromBuyOffers(offers, baseId, cache) {
  const baseNorm = normalizeItemId(baseId);
  const pending = new Map();

  for (const offer of offers || []) {
    if (!isValidOffer(offer)) continue;
    const itemId = normalizeItemId(offer.itemId);
    const payId = normalizeItemId(offer.currencyId);

    if (payId === baseNorm) {
      const rate = paymentPerSoldItemEach(offer);
      if (!isValidNumber(rate)) continue;
      if (!pending.has(itemId)) pending.set(itemId, []);
      pending.get(itemId).push(rate);
      continue;
    }

    const payResolved = cache.get(payId);
    if (!isValidBaseValue(payResolved)) continue;

    const rate = paymentPerSoldItemEach(offer) * payResolved.baseValue;
    if (!isValidNumber(rate)) continue;
    if (!pending.has(itemId)) pending.set(itemId, []);
    pending.get(itemId).push(rate);
  }

  for (const [itemId, rates] of pending) {
    if (rates.length < MIN_SAMPLES_LOOSE) continue;

    const min = Math.min(...rates);
    const max = Math.max(...rates);
    const med = median(rates);
    if (!isValidNumber(med)) continue;
    if (max > med * 3 && rates.length < 3) continue;

    cache.set(itemId, {
      baseValue: med,
      pathDepth: 0,
      confidence: rates.length >= 4 ? 'high' : 'medium',
      sampleCount: rates.length,
      viaBuyOffers: true
    });
  }

  return cache;
}

/**
 * Infer payment-currency value when the same item is listed in base and in that currency.
 */
function refinePaymentCurrencyFromItemMedians(offers, baseId, cache, itemPaymentMedians) {
  const baseNorm = normalizeItemId(baseId);
  const pending = new Map();

  for (const offer of offers || []) {
    if (!isValidOffer(offer)) continue;
    const currencyId = normalizeItemId(offer.currencyId);
    if (currencyId === baseNorm) continue;

    const itemId = normalizeItemId(offer.itemId);
    const med = itemPaymentMedians.get(itemId);
    if (!med) continue;
    const baseMed = med.get(baseNorm);
    const payMed = med.get(currencyId);
    if (!isValidNumber(baseMed) || !isValidNumber(payMed)) continue;

    const rate = baseMed / payMed;
    if (!isValidNumber(rate)) continue;
    if (!pending.has(currencyId)) pending.set(currencyId, []);
    pending.get(currencyId).push(rate);
  }

  for (const [currencyId, rates] of pending) {
    if (rates.length < MIN_SAMPLES_LOOSE) continue;
    const min = Math.min(...rates);
    const max = Math.max(...rates);
    const med = median(rates);
    if (!isValidNumber(med)) continue;
    if (max > med * 3 && rates.length < 3) continue;

    cache.set(currencyId, {
      baseValue: med,
      pathDepth: 1,
      confidence: rates.length >= 4 ? 'high' : 'medium',
      sampleCount: rates.length,
      viaItemMedians: true
    });
  }

  return cache;
}

function runCurrencyRefinementPasses(offers, baseId, cache, itemPaymentMedians, passes = 4) {
  for (let i = 0; i < passes; i++) {
    refineSoldItemBaseValueFromBaseListings(offers, baseId, cache);
    refinePaymentCurrencyCacheFromSoldItems(offers, baseId, cache);
    refineCurrencyValueFromBuyOffers(offers, baseId, cache);
    refinePaymentCurrencyFromItemMedians(offers, baseId, cache, itemPaymentMedians);
  }
  return cache;
}

/**
 * Median payment (per sold item) for each item across currencies — powers same-item cross rates.
 */
function buildItemMedianPaymentPerItem(offers) {
  const buckets = new Map();

  for (const offer of offers || []) {
    if (!isValidOffer(offer)) continue;
    const itemId = normalizeItemId(offer.itemId);
    const currencyId = normalizeItemId(offer.currencyId);
    const rate = paymentPerSoldItemEach(offer);
    if (!isValidNumber(rate)) continue;

    if (!buckets.has(itemId)) buckets.set(itemId, new Map());
    const curMap = buckets.get(itemId);
    if (!curMap.has(currencyId)) curMap.set(currencyId, []);
    curMap.get(currencyId).push(rate);
  }

  const result = new Map();
  for (const [itemId, curMap] of buckets) {
    const medians = new Map();
    for (const [currencyId, rates] of curMap) {
      if (rates.length < MIN_SAMPLES_LOOSE) continue;
      const med = median(rates);
      if (isValidNumber(med)) medians.set(currencyId, med);
    }
    if (medians.size) result.set(itemId, medians);
  }
  return result;
}

function tryItemCrossRateRelativeCost(order, baseId, itemPaymentMedians) {
  const baseNorm = normalizeItemId(baseId);
  const itemId = normalizeItemId(order.itemId);
  const currencyId = normalizeItemId(order.currencyId);
  if (currencyId === baseNorm) return null;

  const curMap = itemPaymentMedians.get(itemId);
  if (!curMap) return null;

  const baseMed = curMap.get(baseNorm);
  const payMed = curMap.get(currencyId);
  if (!isValidNumber(baseMed) || !isValidNumber(payMed)) return null;

  const payPerItem = paymentPerItem(order);
  if (!isValidNumber(payPerItem)) return null;

  const ratio = baseMed / payMed;
  const totalInBase = totalPaymentForOffer(order) * ratio;
  const eachInBase = paymentPerSoldItemEach(order) * ratio;
  if (!isValidRelativeCost(totalInBase)) return null;

  return {
    relativeCost: totalInBase,
    relativeCostUnitPrice: isValidRelativeUnit(eachInBase) ? eachInBase : null,
    marketRateSource: 'item-cross',
    pathDepth: 1,
    confidence: 'medium',
    sampleCount: null
  };
}

function applyImpliedPaymentCurrencyRates(cache, impliedEdges, baseId) {
  const baseNorm = normalizeItemId(baseId);
  for (const edge of impliedEdges?.values() || []) {
    if (normalizeItemId(edge.currencyId) !== baseNorm) continue;
    const currencyId = normalizeItemId(edge.soldId);
    const existing = cache.get(currencyId);
    if (existing?.viaBuyOffers && isValidBaseValue(existing)) continue;
    if (existing?.viaItemMedians && isValidBaseValue(existing)) continue;
    if (existing?.viaSoldItems && isValidBaseValue(existing)) continue;
    if (!isValidNumber(edge.medianRate)) continue;
    cache.set(currencyId, {
      baseValue: edge.medianRate,
      pathDepth: 1,
      confidence: edge.confidence,
      sampleCount: edge.sampleCount,
      viaImplied: true
    });
  }
}

function enrichSingleOffer(order, baseId, baseName, baseValueCache, itemPaymentMedians = new Map()) {
  const enriched = { ...order };
  const nullFields = () => {
    enriched.relativeCost = null;
    enriched.relativeCostUnitPrice = null;
    enriched.relativeCostCurrency = null;
    enriched.marketRateSource = null;
    enriched.pathDepth = null;
    enriched.marketRateSampleCount = null;
    enriched.marketRateConfidence = null;
    return enriched;
  };

  if (!isValidOffer(order)) return nullFields();

  const currencyId = normalizeItemId(order.currencyId);
  const quantity = order.quantity;
  enriched.relativeCostCurrency = baseName;

  if (currencyId === normalizeItemId(baseId)) {
    const relativeCost = totalPaymentForOffer(order);
    const relativeCostUnitPrice = paymentPerSoldItemEach(order);
    if (!isValidRelativeCost(relativeCost)) {
      return nullFields();
    }
    enriched.relativeCost = relativeCost;
    enriched.relativeCostUnitPrice = isValidRelativeUnit(relativeCostUnitPrice)
      ? relativeCostUnitPrice
      : null;
    enriched.marketRateSource = 'base-direct';
    enriched.pathDepth = 0;
    enriched.marketRateSampleCount = null;
    enriched.marketRateConfidence = null;
    return enriched;
  }

  const resolved =
    baseValueCache.get(currencyId) ?? baseValueCache.get(normalizeItemId(currencyId)) ?? null;
  if (isValidBaseValue(resolved)) {
    const relativeCost = totalPaymentForOffer(order) * resolved.baseValue;
    const relativeCostUnitPrice = paymentPerSoldItemEach(order) * resolved.baseValue;
    // #region agent log
    if (normalizeItemId(order.itemId) === -1899491405 && quantity === 2) {
      agentLog(
        'K',
        'market-rates.js:enrichSingleOffer',
        'bp qty2 relative cost',
        {
          costPerItem: order.costPerItem,
          quantity,
          totalPayment: totalPaymentForOffer(order),
          baseValue: resolved.baseValue,
          relativeCost,
          relativeCostUnitPrice
        },
        'post-fix-v13'
      );
    }
    // #endregion
    if (!isValidRelativeCost(relativeCost)) {
      return nullFields();
    }
    enriched.relativeCost = relativeCost;
    enriched.relativeCostUnitPrice = isValidRelativeUnit(relativeCostUnitPrice)
      ? relativeCostUnitPrice
      : null;
    enriched.marketRateSource = 'derived';
    enriched.pathDepth = resolved.pathDepth;
    enriched.marketRateSampleCount = resolved.sampleCount;
    enriched.marketRateConfidence = resolved.confidence;
    return enriched;
  }

  const cross = tryItemCrossRateRelativeCost(order, baseId, itemPaymentMedians);
  if (cross) {
    enriched.relativeCost = cross.relativeCost;
    enriched.relativeCostUnitPrice = cross.relativeCostUnitPrice;
    enriched.marketRateSource = cross.marketRateSource;
    enriched.pathDepth = cross.pathDepth;
    enriched.marketRateSampleCount = cross.sampleCount;
    enriched.marketRateConfidence = cross.confidence;
    return enriched;
  }

  return nullFields();
}

/**
 * Enrich vending machines with relative cost fields and market context.
 */
function enrichOffersWithRelativeCost(machines, itemNames) {
  const flat = flattenOffers(machines);
  const scrapItemId = resolveScrapItemId(itemNames);
  const baseSelection = selectBaseCurrency(flat, scrapItemId);
  const baseId = baseSelection.itemId;
  const baseName = getItemName(itemNames, baseId);
  const forwardEdges = buildReliableExchangeEdges(flat);
  const looseEdges = buildLooseItemCurrencyRates(flat);
  const impliedFromOffers = buildImpliedCurrencyToBaseEdgesFromOffers(flat, baseId);
  const impliedFromForward = buildImpliedCurrencyToBaseEdges(forwardEdges, baseId);
  const impliedFromLoose = buildImpliedCurrencyToBaseEdges(looseEdges, baseId);
  const edges = mergeEdgeMaps(
    forwardEdges,
    mergeEdgeMaps(
      looseEdges,
      mergeEdgeMaps(impliedFromOffers, mergeEdgeMaps(impliedFromForward, impliedFromLoose))
    )
  );

  let baseValueCache = buildBaseValueCache(flat, baseId, edges);
  const itemPaymentMedians = buildItemMedianPaymentPerItem(flat);
  runCurrencyRefinementPasses(flat, baseId, baseValueCache, itemPaymentMedians);
  const allImplied = mergeEdgeMaps(
    impliedFromOffers,
    mergeEdgeMaps(impliedFromForward, impliedFromLoose)
  );
  applyImpliedPaymentCurrencyRates(baseValueCache, allImplied, baseId);

  const METAL_FRAGMENTS_ID = 69511070;

  function cacheSummary(cache, id) {
    const e = cache.get(id);
    return e
      ? {
          baseValue: e.baseValue,
          viaBuyOffers: !!e.viaBuyOffers,
          viaItemMedians: !!e.viaItemMedians,
          viaSoldItems: !!e.viaSoldItems,
          viaDirectListing: !!e.viaDirectListing
        }
      : null;
  }

  // #region agent log
  let mfPaymentOffers = 0;
  const itemsSoldForMf = new Set();
  let dualListScrapAndMf = 0;
  const itemCurrency = new Map();
  for (const o of flat) {
    if (!isValidOffer(o)) continue;
    const itemId = normalizeItemId(o.itemId);
    const currencyId = normalizeItemId(o.currencyId);
    if (!itemCurrency.has(itemId)) itemCurrency.set(itemId, new Set());
    itemCurrency.get(itemId).add(currencyId);
    if (currencyId === METAL_FRAGMENTS_ID) {
      mfPaymentOffers++;
      itemsSoldForMf.add(itemId);
    }
  }
  for (const itemId of itemsSoldForMf) {
    const cur = itemCurrency.get(itemId);
    if (cur && cur.has(baseId) && cur.has(METAL_FRAGMENTS_ID)) dualListScrapAndMf++;
  }
  const mfImplied = impliedFromOffers.get(edgeKey(METAL_FRAGMENTS_ID, baseId))
    ?? impliedFromForward.get(edgeKey(METAL_FRAGMENTS_ID, baseId));
  const mfCache = baseValueCache.get(METAL_FRAGMENTS_ID);
  const mfBridgeRates = [];
  for (const o of flat) {
    if (!isValidOffer(o) || normalizeItemId(o.currencyId) !== METAL_FRAGMENTS_ID) continue;
    const itemId = normalizeItemId(o.itemId);
    const itemVal = baseValueCache.get(itemId);
    if (!itemVal?.baseValue) continue;
    const payPerItem = paymentPerSoldItemEach(o);
    if (!isValidNumber(payPerItem)) continue;
    mfBridgeRates.push({ itemId, rate: itemVal.baseValue / payPerItem, viaSoldItems: !!itemVal.viaSoldItems });
  }

  agentLog('F', 'market-rates.js:enrichOffers', 'metal fragments bridge', {
    mfPaymentOffers,
    uniqueItemsSoldForMf: itemsSoldForMf.size,
    itemsDualListedScrapAndMf: dualListScrapAndMf,
    looseEdgeCount: looseEdges.size,
    impliedFromLooseCount: impliedFromLoose.size,
    metalFragmentsImpliedEdge: mfImplied
      ? { medianRate: mfImplied.medianRate, sampleCount: mfImplied.sampleCount }
      : null,
    metalFragmentsResolved: mfCache
      ? {
          baseValue: mfCache.baseValue,
          pathDepth: mfCache.pathDepth,
          viaSoldItems: !!mfCache.viaSoldItems
        }
      : null,
    mfBridgeRateCount: mfBridgeRates.length,
    mfBridgeRateSample: mfBridgeRates.slice(0, 5),
    impliedFromOffersCount: impliedFromOffers.size,
    impliedCurrencies: [...impliedFromOffers.values()].map(e => e.soldId)
  }, 'post-fix-v5');
  // #endregion

  const enrichedMachines = (machines || []).map(machine => ({
    ...machine,
    sellOrders: (machine.sellOrders || []).map(order =>
      enrichSingleOffer(order, baseId, baseName, baseValueCache, itemPaymentMedians)
    )
  }));

  // #region agent log
  let mfBlank = 0;
  let mfDerived = 0;
  let mfSubCent = 0;
  let mfZero = 0;
  for (const machine of enrichedMachines) {
    for (const order of machine.sellOrders || []) {
      if (normalizeItemId(order.currencyId) !== METAL_FRAGMENTS_ID) continue;
      if (order.marketRateSource === 'derived') mfDerived++;
      if (order.relativeCost == null) mfBlank++;
      else if (order.relativeCost === 0) mfZero++;
      else if (order.relativeCost < MIN_RELATIVE_COST) mfSubCent++;
    }
  }
  const commodityNullSamples = [];
  const commodityDerived = { crude: 0, sulfur: 0, null: 0 };
  for (const machine of enrichedMachines) {
    for (const order of machine.sellOrders || []) {
      const name = getItemName(itemNames, order.itemId).toLowerCase();
      const isCommodity =
        name.includes('crude') || name.includes('sulfur') || name.includes('ore');
      if (!isCommodity) continue;
      if (order.marketRateSource) {
        if (name.includes('crude')) commodityDerived.crude++;
        else commodityDerived.sulfur++;
      } else {
        commodityDerived.null++;
        if (commodityNullSamples.length < 6) {
          const cid = normalizeItemId(order.currencyId);
          commodityNullSamples.push({
            itemId: order.itemId,
            item: getItemName(itemNames, order.itemId),
            currencyId: cid,
            currency: getItemName(itemNames, cid),
            cost: order.costPerItem,
            qty: order.quantity,
            currencyResolved: isValidBaseValue(baseValueCache.get(cid)),
            currencyBaseValue: baseValueCache.get(cid)?.baseValue ?? null,
            itemHasCrossRates: itemPaymentMedians.has(normalizeItemId(order.itemId))
          });
        }
      }
    }
  }
  agentLog('H', 'market-rates.js:enrichOffers', 'commodity relative cost', {
    commodityDerived,
    commodityNullSamples,
    itemPaymentMedianItems: itemPaymentMedians.size
  }, 'post-fix-v10');

  const SEWING_KIT_ID = 1234880403;
  const SULFUR_ORE_ID = -1157596551;
  let sewingPayNull = 0;
  let sewingPayDerived = 0;
  let sulfurPayNull = 0;
  let sulfurPayDerived = 0;
  for (const machine of enrichedMachines) {
    for (const order of machine.sellOrders || []) {
      const cid = normalizeItemId(order.currencyId);
      if (cid === SEWING_KIT_ID) {
        if (order.relativeCost == null) sewingPayNull++;
        else sewingPayDerived++;
      }
      if (cid === SULFUR_ORE_ID) {
        if (order.relativeCost == null) sulfurPayNull++;
        else sulfurPayDerived++;
      }
    }
  }
  agentLog('J', 'market-rates.js:enrichOffers', 'payment currency cache', {
    baseId,
    sewingKit: cacheSummary(baseValueCache, SEWING_KIT_ID),
    sulfurOre: cacheSummary(baseValueCache, SULFUR_ORE_ID),
    sewingPayNull,
    sewingPayDerived,
    sulfurPayNull,
    sulfurPayDerived
  }, 'post-fix-v12');

  agentLog('G', 'market-rates.js:enrichOffers', 'mf relative cost outcome', {
    mfDerived,
    mfBlank,
    mfZero,
    mfSubCent,
    mfCacheViaSoldItems: !!mfCache?.viaSoldItems,
    mfCacheViaImplied: !!mfCache?.viaImplied,
    mfCacheBaseValue: mfCache?.baseValue ?? null
  }, 'post-fix-v6');

  const sourceCounts = { 'base-direct': 0, derived: 0, null: 0 };
  const nullPaymentCurrencies = new Map();
  const typeMismatchSamples = [];
  let mismatchDerivedRecoverable = 0;

  for (const machine of enrichedMachines) {
    for (const order of machine.sellOrders || []) {
      if (order.marketRateSource === 'base-direct') sourceCounts['base-direct']++;
      else if (order.marketRateSource === 'derived') sourceCounts.derived++;
      else sourceCounts.null++;

      if (!order.marketRateSource && isValidOffer(order)) {
        const raw = order.currencyId;
        const norm = normalizeItemId(raw);
        nullPaymentCurrencies.set(String(raw), (nullPaymentCurrencies.get(String(raw)) || 0) + 1);
        const cacheRaw = baseValueCache.get(raw);
        const cacheNorm = baseValueCache.get(norm);
        if (!cacheRaw && cacheNorm) mismatchDerivedRecoverable++;
        if (typeMismatchSamples.length < 8 && raw !== norm && typeof raw !== typeof norm) {
          typeMismatchSamples.push({
            raw,
            rawType: typeof raw,
            norm,
            normType: typeof norm,
            cacheRaw: !!cacheRaw,
            cacheNorm: !!cacheNorm
          });
        }
      }
    }
  }

  const machineKeyStats = { nullKeys: 0, withKey: 0, uniqueKeys: new Set() };
  for (const o of flat) {
    if (o.machineKey) {
      machineKeyStats.withKey++;
      machineKeyStats.uniqueKeys.add(o.machineKey);
    } else machineKeyStats.nullKeys++;
  }

  const paymentCurrencyCache = [];
  const seenPay = new Set();
  for (const o of flat) {
    if (!isValidOffer(o) || seenPay.has(o.currencyId)) continue;
    seenPay.add(o.currencyId);
    paymentCurrencyCache.push({
      currencyId: o.currencyId,
      type: typeof o.currencyId,
      cacheHit: !!baseValueCache.get(o.currencyId),
      cacheHitNorm: !!baseValueCache.get(normalizeItemId(o.currencyId)),
      isBase: o.currencyId === baseId || normalizeItemId(o.currencyId) === baseId
    });
  }

  agentLog('A', 'market-rates.js:enrichOffers', 'machine identity', {
    machineCount: machines?.length ?? 0,
    offerCount: flat.length,
    nullMachineKeys: machineKeyStats.nullKeys,
    offersWithMachineKey: machineKeyStats.withKey,
    uniqueMachineKeys: machineKeyStats.uniqueKeys.size,
    sampleMarkerIds: (machines || []).slice(0, 5).map(m => ({
      id: m.id,
      idType: typeof m.id,
      x: m.x,
      y: m.y,
      key: getMachineKey(m)
    }))
  });

  agentLog('B', 'market-rates.js:enrichOffers', 'graph and base selection', {
    baseId,
    baseIdType: typeof baseId,
    baseName,
    selectedBecause: baseSelection.selectedBecause,
    forwardEdgeCount: forwardEdges.size,
    impliedFromOffersCount: impliedFromOffers.size,
    impliedFromForwardCount: impliedFromForward.size,
    mergedEdgeCount: edges.size,
    impliedCurrencies: [...mergeEdgeMaps(impliedFromOffers, impliedFromForward).values()].map(
      e => e.soldId
    ),
    forwardEdgesToBase: [...forwardEdges.values()].filter(
      e => normalizeItemId(e.currencyId) === baseId
    ).length
  }, 'post-fix');

  agentLog('C', 'market-rates.js:enrichOffers', 'enrichment outcome', {
    sourceCounts,
    mismatchDerivedRecoverable,
    topNullCurrencies: [...nullPaymentCurrencies.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10),
    paymentCurrencyCache: paymentCurrencyCache.slice(0, 15),
    typeMismatchSamples
  }, 'post-fix');

  agentLog('D', 'market-rates.js:enrichOffers', 'cache resolve sample for top null currency', {
    samples: [...nullPaymentCurrencies.keys()].slice(0, 3).map(cid => {
      const num = Number(cid);
      const parsed = normalizeItemId(cid);
      return {
        cid,
        resolveRaw: baseValueCache.get(cid),
        resolveNum: baseValueCache.get(num),
        resolveParsed: baseValueCache.get(parsed),
        adjacencyOutDegree: (buildAdjacency(edges).get(parsed) || []).length
      };
    })
  });
  // #endregion

  const marketContext = {
    selectedBaseCurrencyItemId: baseId,
    selectedBaseCurrencyName: baseName,
    selectedBecause: baseSelection.selectedBecause
  };

  return { machines: enrichedMachines, marketContext };
}

/**
 * Compare relative unit costs for DOM row sorting. Unavailable always sorts last.
 */
function compareRelativeCostUnit(aUnit, bUnit, direction) {
  const aMissing = aUnit === '' || aUnit == null || !Number.isFinite(parseFloat(aUnit));
  const bMissing = bUnit === '' || bUnit == null || !Number.isFinite(parseFloat(bUnit));

  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;

  const aVal = parseFloat(aUnit);
  const bVal = parseFloat(bUnit);
  const result = aVal - bVal;
  return direction === 'asc' ? result : -result;
}

// Legacy alias for tests migrating gradually
const enrichOffersWithScrapEquivalents = (machines, scrapItemId) => {
  const itemNames = { [String(scrapItemId)]: { name: 'Scrap', short: 'scrap' } };
  return enrichOffersWithRelativeCost(machines, itemNames).machines;
};

const compareScrapEquivUnit = compareRelativeCostUnit;

module.exports = {
  SCRAP_ITEM_ID_FALLBACK,
  HQM_ITEM_ID,
  MAX_PATH_DEPTH,
  resolveScrapItemId,
  getItemName,
  flattenOffers,
  buildReliableExchangeEdges,
  buildLooseItemCurrencyRates,
  buildImpliedCurrencyToBaseEdgesFromOffers,
  buildImpliedCurrencyToBaseEdges,
  mergeEdgeMaps,
  getMachineKey,
  scorePaymentItems,
  selectBaseCurrency,
  resolveToBase,
  buildBaseValueCache,
  buildAdjacency,
  enrichSingleOffer,
  enrichOffersWithRelativeCost,
  compareRelativeCostUnit,
  enrichOffersWithScrapEquivalents,
  compareScrapEquivUnit,
  median,
  isValidOffer,
  passesConfidenceGate
};

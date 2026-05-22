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

/** Stack totals can be well below 1 cent when unit value is tiny (e.g. blueprint fragments). */
function isValidRelativeValueTotal(value) {
  return isValidNumber(value) && value >= MIN_RELATIVE_UNIT;
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

/** Rust+ SellOrder: costPerItem is total payment for the listed stack (divide by item qty for per-unit). */
function paymentPerItem(offer) {
  return offer.costPerItem;
}

function coefficientOfVariation(values) {
  if (!values || values.length < 2) return Infinity;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (!Number.isFinite(mean) || mean === 0) return Infinity;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / Math.abs(mean);
}

/**
 * Detect whether costPerItem is per sold item or total payment for the listed stack.
 * Stack-total: cost/qty is stable while headline cost varies (1250/1000 ≈ 625/500 scrap per MF).
 * Bulk resources often use a small total in costPerItem (e.g. 20 scrap for 1000 wood).
 */
function detectPricingModel(offers) {
  if (!offers || offers.length < 2) return 'per-item';

  const multiQty = offers.filter(o => isValidOffer(o) && o.quantity > 1);
  if (multiQty.length >= 2) {
    const unitRates = multiQty.map(o => o.costPerItem / o.quantity);
    const costs = multiQty.map(o => o.costPerItem);
    const unitCv = coefficientOfVariation(unitRates);
    const costCv = coefficientOfVariation(costs);
    const medUnit = median(unitRates);
    const unitSpread =
      isValidNumber(medUnit) && medUnit > 0
        ? (Math.max(...unitRates) - Math.min(...unitRates)) / medUnit
        : Infinity;
    if ((unitCv < 0.25 || unitSpread < 0.15) && costCv > 0.25) return 'stack-total';
  }

  return 'per-item';
}

function buildItemCurrencyPricingModels(offers) {
  const groups = new Map();
  for (const offer of offers || []) {
    if (!isValidOffer(offer)) continue;
    const key = edgeKey(offer.itemId, offer.currencyId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(offer);
  }
  const models = new Map();
  for (const [key, group] of groups) {
    models.set(key, detectPricingModel(group));
  }
  return models;
}

function attachPricingModels(offers, models) {
  const groups = new Map();
  for (const offer of offers || []) {
    if (!isValidOffer(offer)) continue;
    const key = edgeKey(offer.itemId, offer.currencyId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(offer);
  }
  for (const [key, group] of groups) {
    const model = models.get(key) ?? 'per-item';
    for (const offer of group) {
      offer._pricingModel = model;
    }
  }
}

function attachPricingModelsToMachines(machines, models) {
  for (const machine of machines || []) {
    for (const order of machine.sellOrders || []) {
      if (!isValidOffer(order)) continue;
      const itemId = normalizeItemId(order.itemId);
      const currencyId = normalizeItemId(order.currencyId);
      order._pricingModel = models.get(edgeKey(itemId, currencyId)) ?? 'per-item';
    }
  }
}

function getOfferPricingModel(offer) {
  return offer?._pricingModel === 'stack-total' ? 'stack-total' : 'per-item';
}

/**
 * Total payment (cost currency) and per sold-item unit rate for one listing.
 * costPerItem is always the total for the stack; unit = costPerItem / item qty.
 */
function listingTotalAndUnit(offer) {
  const total = paymentPerItem(offer);
  const qty = soldStackSize(offer);
  if (!Number.isFinite(total) || !Number.isFinite(qty) || qty <= 0) {
    return { total: NaN, unit: NaN };
  }
  return { total, unit: total / qty };
}

/** Total payment currency for the full listing. */
function totalPaymentForOffer(offer) {
  return listingTotalAndUnit(offer).total;
}

/** @deprecated alias */
function totalPaymentInCurrency(offer) {
  return totalPaymentForOffer(offer);
}

/** Scrap (or payment) per one sold item = costPerItem / item qty. */
function scrapRatePerSoldItem(offer) {
  return listingTotalAndUnit(offer).unit;
}

/**
 * Scrap per one sold item from a listing paid in another currency.
 * Uses total payment (costPerItem) × currency scrap rate, then ÷ item qty — same as relative cost / item qty.
 */
function scrapPerSoldItemFromPaymentListing(offer, currencyBaseValuePerUnit) {
  const payTotal = paymentPerItem(offer);
  const qty = soldStackSize(offer);
  if (!isValidNumber(payTotal) || !isValidNumber(currencyBaseValuePerUnit) || !isValidNumber(qty) || qty <= 0) {
    return NaN;
  }
  return (payTotal * currencyBaseValuePerUnit) / qty;
}

/** Items with at least one sell listing priced directly in the base currency. */
function buildDirectScrapSoldItemIds(offers, baseId) {
  const baseNorm = normalizeItemId(baseId);
  const ids = new Set();
  for (const offer of offers || []) {
    if (!isValidOffer(offer)) continue;
    if (normalizeItemId(offer.currencyId) !== baseNorm) continue;
    ids.add(normalizeItemId(offer.itemId));
  }
  return ids;
}

/** @deprecated alias — use scrapRatePerSoldItem for value rates */
function paymentPerSoldItemEach(offer) {
  return scrapRatePerSoldItem(offer);
}

/** Sold stack size (matches UI Item Qty). */
function soldStackSize(offer) {
  return offer.quantity;
}

/** Cost Qty column — payment in cost currency; relative cost never uses item qty. */
function costQtyInCurrency(offer) {
  return offer.costPerItem;
}

/** Relative Cost (Each) = Relative Cost ÷ Cost Qty (scrap per one cost-currency unit). */
function relativeCostEachFromTotal(relativeCostTotal, offer) {
  const costQty = costQtyInCurrency(offer);
  if (!isValidRelativeCost(relativeCostTotal) || !isValidNumber(costQty) || costQty <= 0) {
    return null;
  }
  const each = relativeCostTotal / costQty;
  return isValidRelativeUnit(each) ? each : null;
}

/** Total sold-item value in base given per-unit base value (uses Item Qty). */
function totalSoldValueInBase(offer, baseValuePerUnit) {
  return offer.quantity * baseValuePerUnit;
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
  const directScrapSoldItems = buildDirectScrapSoldItemIds(offers, baseId);

  for (let pass = 0; pass < maxPasses; pass++) {
    const pending = new Map();

    for (const offer of offers || []) {
      if (!isValidOffer(offer)) continue;
      const currencyId = normalizeItemId(offer.currencyId);
      if (currencyId === baseNorm) continue;
      // Never infer HQM (etc.) from wood→HQM when that currency is also sold for scrap.
      if (directScrapSoldItems.has(currencyId)) continue;

      const existing = cache.get(currencyId) ?? cache.get(normalizeItemId(currencyId));
      if (existing?.viaDirectListing && isValidBaseValue(existing)) continue;
      if (existing?.viaBuyOffers && isValidBaseValue(existing)) continue;
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
 * Value items from shop ask prices.
 * Scrap-priced sold listings (via refineSoldItem) always win — never blend with cross-currency asks.
 */
function refineCurrencyValueFromBuyOffers(offers, baseId, cache) {
  const baseNorm = normalizeItemId(baseId);
  const pendingScrap = new Map();
  const pendingCrossAsk = new Map();

  for (const offer of offers || []) {
    if (!isValidOffer(offer)) continue;
    const itemId = normalizeItemId(offer.itemId);
    const payId = normalizeItemId(offer.currencyId);

    if (payId === baseNorm) {
      const rate = paymentPerSoldItemEach(offer);
      if (!isValidNumber(rate)) continue;
      if (!pendingScrap.has(itemId)) pendingScrap.set(itemId, []);
      pendingScrap.get(itemId).push(rate);
      continue;
    }

    const payResolved =
      cache.get(payId) ?? cache.get(normalizeItemId(payId)) ?? null;
    if (!isValidBaseValue(payResolved)) continue;

    const rate = scrapPerSoldItemFromPaymentListing(offer, payResolved.baseValue);
    if (!isValidNumber(rate)) continue;
    if (!pendingCrossAsk.has(itemId)) pendingCrossAsk.set(itemId, []);
    pendingCrossAsk.get(itemId).push(rate);
  }

  for (const [itemId, rates] of pendingScrap) {
    if (rates.length < MIN_SAMPLES_LOOSE) continue;

    const existing = cache.get(itemId) ?? cache.get(normalizeItemId(itemId));
    if (existing?.viaDirectListing && isValidBaseValue(existing)) continue;

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

  for (const [itemId, rates] of pendingCrossAsk) {
    if (rates.length < MIN_SAMPLES_LOOSE) continue;

    const existing = cache.get(itemId) ?? cache.get(normalizeItemId(itemId));
    if (isValidBaseValue(existing)) continue;

    const min = Math.min(...rates);
    const max = Math.max(...rates);
    const med = median(rates);
    if (!isValidNumber(med)) continue;
    if (max > med * 3 && rates.length < 3) continue;

    cache.set(itemId, {
      baseValue: med,
      pathDepth: 1,
      confidence: rates.length >= 4 ? 'high' : 'medium',
      sampleCount: rates.length,
      viaBuyOffers: true,
      viaBuyOffersCross: true
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

    const existing = cache.get(currencyId) ?? cache.get(normalizeItemId(currencyId));
    if (existing?.viaDirectListing && isValidBaseValue(existing)) continue;
    if (existing?.viaBuyOffers && isValidBaseValue(existing)) continue;

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

/**
 * Median scrap-per-sold-item from sell listings (total cost converted to scrap ÷ item qty).
 * Matches relative cost total ÷ item qty, not relative cost (each) ÷ item qty.
 */
function refineItemValueFromPaymentListings(offers, baseId, cache) {
  const baseNorm = normalizeItemId(baseId);
  const pending = new Map();

  for (const offer of offers || []) {
    if (!isValidOffer(offer)) continue;
    const currencyId = normalizeItemId(offer.currencyId);
    if (currencyId === baseNorm) continue;

    const payResolved =
      cache.get(currencyId) ?? cache.get(normalizeItemId(currencyId)) ?? null;
    if (!isValidBaseValue(payResolved)) continue;

    const unitInBase = scrapPerSoldItemFromPaymentListing(offer, payResolved.baseValue);
    if (!isValidNumber(unitInBase)) continue;

    const itemId = normalizeItemId(offer.itemId);
    if (!pending.has(itemId)) pending.set(itemId, []);
    pending.get(itemId).push(unitInBase);
  }

  for (const [itemId, rates] of pending) {
    if (rates.length < MIN_SAMPLES_LOOSE) continue;

    const min = Math.min(...rates);
    const max = Math.max(...rates);
    const med = median(rates);
    if (!isValidNumber(med)) continue;
    if (max > med * 3 && rates.length < 3) continue;

    const existing = cache.get(itemId) ?? cache.get(normalizeItemId(itemId));
    if (existing?.viaDirectListing && isValidBaseValue(existing)) continue;

    cache.set(itemId, {
      baseValue: med,
      pathDepth: 1,
      confidence: rates.length >= 4 ? 'high' : 'medium',
      sampleCount: rates.length,
      viaPaymentListings: true
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
  refineItemValueFromPaymentListings(offers, baseId, cache);
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

/**
 * Median implied base per unit when an item is used as payment (other items sold for it).
 */
function buildPaymentCurrencyImpliedBaseMedians(offers, baseId, cache) {
  const baseNorm = normalizeItemId(baseId);
  const pending = new Map();

  for (const offer of offers || []) {
    if (!isValidOffer(offer)) continue;
    const currencyId = normalizeItemId(offer.currencyId);
    if (currencyId === baseNorm) continue;

    const itemId = normalizeItemId(offer.itemId);
    const itemResolved = cache.get(itemId) ?? cache.get(normalizeItemId(itemId)) ?? null;
    if (!isValidBaseValue(itemResolved)) continue;

    const totalPay = totalPaymentForOffer(offer);
    if (!isValidNumber(totalPay)) continue;

    const impliedPerUnit = (itemResolved.baseValue * offer.quantity) / totalPay;
    if (!isValidNumber(impliedPerUnit)) continue;

    if (!pending.has(currencyId)) pending.set(currencyId, []);
    pending.get(currencyId).push(impliedPerUnit);
  }

  const result = new Map();
  for (const [currencyId, rates] of pending) {
    if (rates.length < MIN_SAMPLES_LOOSE) continue;
    const min = Math.min(...rates);
    const max = Math.max(...rates);
    const med = median(rates);
    if (!isValidNumber(med)) continue;
    if (max > med * 3 && rates.length < 3) continue;
    result.set(currencyId, med);
  }
  return result;
}

/** Push payment-role medians into cache when sold-item paths did not resolve. */
function applyPaymentRoleMediansToCache(cache, paymentRoleMedians) {
  for (const [currencyId, med] of paymentRoleMedians) {
    const existing = cache.get(currencyId) ?? cache.get(normalizeItemId(currencyId));
    if (existing?.viaDirectListing && isValidBaseValue(existing)) continue;
    if (isValidBaseValue(existing)) continue;
    cache.set(currencyId, {
      baseValue: med,
      pathDepth: 1,
      confidence: 'medium',
      sampleCount: MIN_SAMPLES_LOOSE,
      viaPaymentRole: true
    });
  }
  return cache;
}

/** Let item-cross use base median for items that only appear as payment currency. */
function mergePaymentRoleIntoItemMedians(itemPaymentMedians, paymentRoleMedians, baseId) {
  const baseNorm = normalizeItemId(baseId);
  for (const [itemId, med] of paymentRoleMedians) {
    let curMap = itemPaymentMedians.get(itemId);
    if (!curMap) {
      curMap = new Map();
      itemPaymentMedians.set(itemId, curMap);
    }
    if (!curMap.has(baseNorm)) {
      curMap.set(baseNorm, med);
    }
  }
  return itemPaymentMedians;
}

/** Value from same-item sold listings: cross payment currency vs base (mirrors cost item-cross). */
function tryItemCrossRateRelativeValue(order, baseId, itemPaymentMedians) {
  const baseNorm = normalizeItemId(baseId);
  const itemId = normalizeItemId(order.itemId);
  const currencyId = normalizeItemId(order.currencyId);
  if (itemId === baseNorm) return null;

  const curMap = itemPaymentMedians.get(itemId);
  if (!curMap) return null;

  const baseMed = curMap.get(baseNorm);
  if (!isValidNumber(baseMed)) return null;

  const qty = soldStackSize(order);
  if (!isValidNumber(qty)) return null;

  let unitInBase;
  if (currencyId === baseNorm) {
    unitInBase = baseMed;
  } else {
    const payMed = curMap.get(currencyId);
    if (!isValidNumber(payMed)) return null;
    unitInBase = baseMed / payMed;
  }

  const totalInBase = qty * unitInBase;
  if (!isValidRelativeValueTotal(totalInBase)) return null;

  return {
    relativeValue: totalInBase,
    relativeValueUnitPrice: isValidRelativeUnit(unitInBase) ? unitInBase : null,
    marketRateSource: 'item-cross-value'
  };
}

/** Value when item only appears as payment currency in other listings. */
function tryPaymentRoleMedianRelativeValue(order, paymentRoleMedians) {
  const itemId = normalizeItemId(order.itemId);
  const med = paymentRoleMedians.get(itemId) ?? paymentRoleMedians.get(normalizeItemId(itemId));
  if (!isValidNumber(med)) return null;

  const qty = soldStackSize(order);
  if (!isValidNumber(qty)) return null;

  const totalInBase = totalSoldValueInBase(order, med);
  if (!isValidRelativeValueTotal(totalInBase)) return null;

  return {
    relativeValue: totalInBase,
    relativeValueUnitPrice: isValidRelativeUnit(med) ? med : null,
    marketRateSource: 'payment-role-median'
  };
}

function tryCurrencyDerivedRelativeValue(order, baseId, baseValueCache) {
  const baseNorm = normalizeItemId(baseId);
  const itemId = normalizeItemId(order.itemId);
  const currencyId = normalizeItemId(order.currencyId);
  if (itemId === baseNorm || currencyId === baseNorm) return null;

  const resolved =
    baseValueCache.get(currencyId) ?? baseValueCache.get(normalizeItemId(currencyId)) ?? null;
  if (!isValidBaseValue(resolved)) return null;

  const payEach = paymentPerSoldItemEach(order);
  const qty = soldStackSize(order);
  if (!isValidNumber(payEach) || !isValidNumber(qty)) return null;

  const unitInBase = payEach * resolved.baseValue;
  const totalInBase = qty * unitInBase;
  if (!isValidRelativeValueTotal(totalInBase)) return null;

  return {
    relativeValue: totalInBase,
    relativeValueUnitPrice: isValidRelativeUnit(unitInBase) ? unitInBase : null
  };
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

  const costQty = costQtyInCurrency(order);
  if (!isValidNumber(costQty)) return null;

  const ratio = baseMed / payMed;
  const inBase = costQty * ratio;
  if (!isValidRelativeCost(inBase)) return null;

  return {
    relativeCost: inBase,
    relativeCostUnitPrice: relativeCostEachFromTotal(inBase, order),
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
    if (existing?.viaDirectListing && isValidBaseValue(existing)) continue;
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

function enrichSingleOffer(
  order,
  baseId,
  baseName,
  baseValueCache,
  itemPaymentMedians = new Map(),
  paymentRoleMedians = new Map()
) {
  const enriched = { ...order, _pricingModel: getOfferPricingModel(order) };
  const nullFields = () => {
    enriched.relativeCost = null;
    enriched.relativeCostUnitPrice = null;
    enriched.relativeCostCurrency = null;
    enriched.relativeValue = null;
    enriched.relativeValueUnitPrice = null;
    enriched.relativeValueCurrency = null;
    enriched.relativeSpread = null;
    enriched.marketRateSource = null;
    enriched.pathDepth = null;
    enriched.marketRateSampleCount = null;
    enriched.marketRateConfidence = null;
    return enriched;
  };

  if (!isValidOffer(order)) return nullFields();

  const baseNorm = normalizeItemId(baseId);
  const currencyId = normalizeItemId(order.currencyId);
  const itemId = normalizeItemId(order.itemId);
  const quantity = order.quantity;
  enriched.relativeCostCurrency = baseName;
  enriched.relativeValueCurrency = baseName;

  let relativeCost = null;
  let relativeCostUnitPrice = null;
  let marketRateSource = null;
  let pathDepth = null;
  let marketRateSampleCount = null;
  let marketRateConfidence = null;

  if (currencyId === baseNorm) {
    const costInBase = costQtyInCurrency(order);
    if (isValidRelativeCost(costInBase)) {
      relativeCost = costInBase;
      relativeCostUnitPrice = relativeCostEachFromTotal(costInBase, order);
      marketRateSource = 'base-direct';
      pathDepth = 0;
    }
  } else {
    const payResolved =
      baseValueCache.get(currencyId) ?? baseValueCache.get(normalizeItemId(currencyId)) ?? null;
    if (isValidBaseValue(payResolved)) {
      const costInBase = costQtyInCurrency(order) * payResolved.baseValue;
      if (isValidRelativeCost(costInBase)) {
        relativeCost = costInBase;
        relativeCostUnitPrice = relativeCostEachFromTotal(costInBase, order);
        marketRateSource = 'derived';
        pathDepth = payResolved.pathDepth;
        marketRateSampleCount = payResolved.sampleCount;
        marketRateConfidence = payResolved.confidence;
      }
    } else {
      const costCross = tryItemCrossRateRelativeCost(order, baseId, itemPaymentMedians);
      if (costCross) {
        relativeCost = costCross.relativeCost;
        relativeCostUnitPrice = costCross.relativeCostUnitPrice;
        marketRateSource = costCross.marketRateSource;
        pathDepth = costCross.pathDepth;
        marketRateSampleCount = costCross.sampleCount;
        marketRateConfidence = costCross.confidence;
      }
    }
  }

  let relativeValue = null;
  let relativeValueUnitPrice = null;

  if (itemId === baseNorm) {
    const value = soldStackSize(order);
    if (isValidRelativeValueTotal(value)) {
      relativeValue = value;
      relativeValueUnitPrice = 1;
    }
  } else if (currencyId === baseNorm) {
    const { total, unit } = listingTotalAndUnit(order);
    if (isValidRelativeValueTotal(total) && isValidRelativeUnit(unit)) {
      relativeValue = total;
      relativeValueUnitPrice = unit;
      enriched._valueCacheSource = 'listing-scrap-total';
    }
  } else {
    const itemResolved =
      baseValueCache.get(itemId) ?? baseValueCache.get(normalizeItemId(itemId)) ?? null;
    if (isValidBaseValue(itemResolved)) {
      const valueEach = itemResolved.baseValue;
      const value = totalSoldValueInBase(order, valueEach);
      if (isValidRelativeValueTotal(value) && isValidRelativeUnit(valueEach)) {
        relativeValue = value;
        relativeValueUnitPrice = valueEach;
        enriched._valueCacheSource = itemResolved.viaDirectListing
          ? 'direct-scrap'
          : itemResolved.viaBuyOffers
            ? itemResolved.viaBuyOffersCross
              ? 'buy-offers-cross'
              : 'buy-offers-scrap'
            : itemResolved.viaPaymentListings
              ? 'payment-listings-median'
              : itemResolved.viaPaymentRole
                ? 'payment-role'
                : itemResolved.viaSoldItems
                  ? 'sold-items'
                  : itemResolved.viaItemMedians
                    ? 'item-medians'
                    : itemResolved.viaImplied
                      ? 'implied'
                      : 'cache';
      }
    } else {
      const valueCross = tryItemCrossRateRelativeValue(order, baseId, itemPaymentMedians);
      if (valueCross) {
        relativeValue = valueCross.relativeValue;
        relativeValueUnitPrice = valueCross.relativeValueUnitPrice;
      } else {
        const valuePaymentRole = tryPaymentRoleMedianRelativeValue(order, paymentRoleMedians);
        if (valuePaymentRole) {
          relativeValue = valuePaymentRole.relativeValue;
          relativeValueUnitPrice = valuePaymentRole.relativeValueUnitPrice;
        } else {
          const valueDerived = tryCurrencyDerivedRelativeValue(order, baseId, baseValueCache);
          if (valueDerived) {
            relativeValue = valueDerived.relativeValue;
            relativeValueUnitPrice = valueDerived.relativeValueUnitPrice;
          }
        }
      }
    }
  }

  enriched.relativeCost = relativeCost;
  enriched.relativeCostUnitPrice = relativeCostUnitPrice;
  enriched.relativeValue = relativeValue;
  enriched.relativeValueUnitPrice = relativeValueUnitPrice;

  enriched.marketRateSource = marketRateSource;
  enriched.pathDepth = pathDepth;
  enriched.marketRateSampleCount = marketRateSampleCount;
  enriched.marketRateConfidence = marketRateConfidence;

  if (isValidRelativeValueTotal(relativeValue) && isValidRelativeCost(relativeCost)) {
    enriched.relativeSpread = relativeValue - relativeCost;
  } else {
    enriched.relativeSpread = null;
  }

  return enriched;
}

/**
 * Enrich vending machines with relative cost fields and market context.
 */
function enrichOffersWithRelativeCost(machines, itemNames) {
  const flat = flattenOffers(machines);
  const pricingModels = buildItemCurrencyPricingModels(flat);
  attachPricingModels(flat, pricingModels);
  attachPricingModelsToMachines(machines, pricingModels);
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
  const paymentRoleMedians = buildPaymentCurrencyImpliedBaseMedians(flat, baseId, baseValueCache);
  applyPaymentRoleMediansToCache(baseValueCache, paymentRoleMedians);
  mergePaymentRoleIntoItemMedians(itemPaymentMedians, paymentRoleMedians, baseId);
  const allImplied = mergeEdgeMaps(
    impliedFromOffers,
    mergeEdgeMaps(impliedFromForward, impliedFromLoose)
  );
  applyImpliedPaymentCurrencyRates(baseValueCache, allImplied, baseId);

  const enrichedMachines = (machines || []).map(machine => ({
    ...machine,
    sellOrders: (machine.sellOrders || []).map(order =>
      enrichSingleOffer(order, baseId, baseName, baseValueCache, itemPaymentMedians, paymentRoleMedians)
    )
  }));

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
function compareRelativeNumeric(aVal, bVal, direction) {
  const aMissing = aVal === '' || aVal == null || !Number.isFinite(parseFloat(aVal));
  const bMissing = bVal === '' || bVal == null || !Number.isFinite(parseFloat(bVal));

  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;

  const result = parseFloat(aVal) - parseFloat(bVal);
  return direction === 'asc' ? result : -result;
}

function compareRelativeCostUnit(aUnit, bUnit, direction) {
  return compareRelativeNumeric(aUnit, bUnit, direction);
}

function compareRelativeValueUnit(aUnit, bUnit, direction) {
  return compareRelativeNumeric(aUnit, bUnit, direction);
}

function compareRelativeSpread(aSpread, bSpread, direction) {
  return compareRelativeNumeric(aSpread, bSpread, direction);
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
  compareRelativeValueUnit,
  compareRelativeSpread,
  enrichOffersWithScrapEquivalents,
  compareScrapEquivUnit,
  median,
  isValidOffer,
  passesConfidenceGate,
  detectPricingModel,
  buildItemCurrencyPricingModels,
  attachPricingModels,
  scrapRatePerSoldItem,
  scrapPerSoldItemFromPaymentListing,
  refineItemValueFromPaymentListings
};

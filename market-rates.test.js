const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  SCRAP_ITEM_ID_FALLBACK,
  HQM_ITEM_ID,
  selectBaseCurrency,
  buildReliableExchangeEdges,
  buildImpliedCurrencyToBaseEdgesFromOffers,
  buildImpliedCurrencyToBaseEdges,
  mergeEdgeMaps,
  buildBaseValueCache,
  resolveToBase,
  enrichOffersWithRelativeCost,
  enrichSingleOffer,
  detectPricingModel,
  buildItemCurrencyPricingModels,
  compareRelativeCostUnit,
  compareRelativeValueUnit,
  compareRelativeSpread,
  flattenOffers
} = require('./market-rates');

const SCRAP = SCRAP_ITEM_ID_FALLBACK;
const HQM = HQM_ITEM_ID;
const BLUEPRINT = 999001;
const METAL_FRAGMENTS = 69511070;
const WOOD = -1461508848;
const SULFUR = -1581843485;

const ITEM_NAMES = {
  [String(SCRAP)]: { name: 'Scrap', short: 'scrap' },
  [String(HQM)]: { name: 'High Quality Metal', short: 'metal.hq' },
  [String(BLUEPRINT)]: { name: 'Blueprint Fragment', short: 'blueprint' },
  [String(WOOD)]: { name: 'Wood', short: 'wood' },
  [String(METAL_FRAGMENTS)]: { name: 'Metal Fragments', short: 'metal.fragments' },
  [String(SULFUR)]: { name: 'Sulfur', short: 'sulfur' }
};

function machine(id, orders) {
  return { id, name: `Shop ${id}`, x: 0, y: 0, sellOrders: orders };
}

function listing(itemId, currencyId, cost, qty, machineId, stock = 100) {
  return {
    itemId,
    currencyId,
    costPerItem: cost,
    quantity: qty,
    amountInStock: stock,
    machineId
  };
}

function scrapPaymentListings(itemId, scrapCost, qty, machineIds) {
  return machineIds.map((mid, i) =>
    listing(itemId, SCRAP, scrapCost + i, qty, mid)
  );
}

describe('relative cost / market-rates', () => {
  it('1. selects Scrap when it is the most liquid payment currency', () => {
    const offers = [];
    for (let i = 1; i <= 3; i++) {
      offers.push(listing(BLUEPRINT, SCRAP, 100, 1, i));
      offers.push(listing(WOOD, SCRAP, 50, 1, i + 10));
    }
    const base = selectBaseCurrency(offers, SCRAP);
    assert.equal(base.itemId, SCRAP);
    assert.equal(base.selectedBecause, 'highest-score');
  });

  it('selects HQM over Scrap when HQM is more liquid even if Scrap has wide coverage', () => {
    const offers = [];
    for (let i = 1; i <= 4; i++) {
      offers.push(listing(BLUEPRINT, SCRAP, 100, 1, i));
      offers.push(listing(WOOD, SCRAP, 50, 1, i + 10));
    }
    for (let i = 1; i <= 8; i++) {
      offers.push(listing(BLUEPRINT, HQM, 10, 1, i + 20));
      offers.push(listing(WOOD, HQM, 5, 1, i + 30));
    }
    const base = selectBaseCurrency(offers, SCRAP);
    assert.equal(base.itemId, HQM);
    assert.equal(base.selectedBecause, 'highest-score');
  });

  it('2. selects HQM when Scrap has poor payment coverage', () => {
    const offers = [
      listing(BLUEPRINT, SCRAP, 100, 1, 1),
      listing(BLUEPRINT, HQM, 10, 1, 2),
      listing(BLUEPRINT, HQM, 10, 1, 3),
      listing(WOOD, HQM, 5, 1, 4),
      listing(WOOD, HQM, 5, 1, 5),
      listing(WOOD, HQM, 3, 1, 6),
      listing(BLUEPRINT, HQM, 10, 1, 7)
    ];
    const base = selectBaseCurrency(offers, SCRAP);
    assert.equal(base.itemId, HQM);
    assert.equal(base.selectedBecause, 'highest-score');
  });

  it('3. resolves relative value through indirect path', () => {
    const machines = [
      machine(1, [listing(HQM, SCRAP, 50, 1, 1)]),
      machine(2, [listing(HQM, SCRAP, 50, 1, 2)]),
      machine(3, [listing(HQM, SCRAP, 52, 1, 3)]),
      machine(4, [
        listing(BLUEPRINT, HQM, 10, 1, 4),
        listing(BLUEPRINT, HQM, 10, 1, 5)
      ])
    ];
    const { machines: enriched, marketContext } = enrichOffersWithRelativeCost(machines, ITEM_NAMES);
    assert.equal(marketContext.selectedBaseCurrencyItemId, SCRAP);

    const bpOffer = enriched[3].sellOrders.find(o => o.itemId === BLUEPRINT);
    assert.equal(bpOffer.marketRateSource, 'derived');
    assert.equal(bpOffer.relativeCost, 500);
    assert.equal(bpOffer.relativeCostCurrency, 'Scrap');
    assert.equal(bpOffer.relativeValue, 500);
    assert.equal(bpOffer.relativeValueUnitPrice, 500);
    assert.equal(bpOffer.relativeSpread, 0);
  });

  it('4. leaves relative cost blank when no path to base exists', () => {
    const machines = [
      machine(1, scrapPaymentListings(HQM, 50, 1, [1, 2, 3])),
      machine(2, [listing(BLUEPRINT, WOOD, 100, 1, 4)])
    ];
    const { machines: enriched } = enrichOffersWithRelativeCost(machines, ITEM_NAMES);
    const isolated = enriched[1].sellOrders[0];
    assert.equal(isolated.relativeCost, null);
    assert.equal(isolated.relativeValue, null);
    assert.equal(isolated.relativeSpread, null);
    assert.equal(isolated.marketRateSource, null);
  });

  it('5. circular exchange paths do not crash', () => {
    const offers = [
      listing(HQM, WOOD, 10, 1, 1),
      listing(HQM, WOOD, 10, 1, 2),
      listing(HQM, WOOD, 10, 1, 3),
      listing(WOOD, HQM, 5, 1, 4),
      listing(WOOD, HQM, 5, 1, 5),
      listing(WOOD, HQM, 5, 1, 6),
      ...scrapPaymentListings(HQM, 50, 1, [7, 8, 9])
    ];
    assert.doesNotThrow(() => {
      const edges = buildReliableExchangeEdges(offers);
      resolveToBase(BLUEPRINT, SCRAP, edges);
      enrichOffersWithRelativeCost([machine(1, offers)], ITEM_NAMES);
    });
  });

  it('6. base-direct offer shows relative cost in base currency', () => {
    const order = listing(BLUEPRINT, SCRAP, 200, 1, 1);
    const edges = buildReliableExchangeEdges([order]);
    const cache = buildBaseValueCache([order], SCRAP, edges);
    const enriched = enrichSingleOffer(order, SCRAP, 'Scrap', cache);
    assert.equal(enriched.relativeCost, 200);
    assert.equal(enriched.relativeCostUnitPrice, 1);
    assert.equal(enriched.marketRateSource, 'base-direct');
    assert.equal(enriched.pathDepth, 0);
  });

  it('detects stack-total when payment per sold item is stable across quantities', () => {
    const offers = [
      listing(METAL_FRAGMENTS, SCRAP, 1250, 1000, 1),
      listing(METAL_FRAGMENTS, SCRAP, 625, 500, 2)
    ];
    const models = buildItemCurrencyPricingModels(offers);
    assert.equal(models.get(`${METAL_FRAGMENTS}:${SCRAP}`), 'stack-total');
    assert.equal(detectPricingModel(offers), 'stack-total');
  });

  it('same cost across quantities is per-item (Rust+ default), not stack-total', () => {
    const offers = [
      listing(HQM, SCRAP, 50, 1, 1),
      listing(HQM, SCRAP, 50, 1000, 2)
    ];
    assert.equal(detectPricingModel(offers), 'per-item');
    assert.equal(buildItemCurrencyPricingModels(offers).get(`${HQM}:${SCRAP}`), 'per-item');
  });

  it('HQM scrap price beats cross-currency ask pollution; wood stays below HQM', () => {
    const machines = [
      machine(1, [
        listing(HQM, SCRAP, 50, 1, 1),
        listing(HQM, SCRAP, 50, 1, 2),
        listing(HQM, SCRAP, 50, 1, 3)
      ]),
      machine(2, [
        listing(WOOD, SCRAP, 1, 1, 4),
        listing(WOOD, SCRAP, 1, 1, 5),
        listing(WOOD, SCRAP, 1, 1, 6)
      ]),
      machine(3, [listing(HQM, WOOD, 100, 1, 7), listing(HQM, WOOD, 100, 1, 8)]),
      machine(4, [listing(WOOD, HQM, 50, 1, 9), listing(WOOD, HQM, 50, 1, 10)])
    ];
    const { machines: enriched } = enrichOffersWithRelativeCost(machines, ITEM_NAMES);
    const hqm = enriched[0].sellOrders[0];
    const wood = enriched[1].sellOrders[0];
    assert.equal(hqm.relativeValueUnitPrice, 50);
    assert.equal(wood.relativeValueUnitPrice, 1);
    assert.ok(hqm.relativeValueUnitPrice > wood.relativeValueUnitPrice * 5);
    assert.ok(
      hqm._valueCacheSource === 'direct-scrap' || hqm._valueCacheSource === 'listing-scrap-total'
    );
    assert.ok(
      wood._valueCacheSource === 'direct-scrap' || wood._valueCacheSource === 'listing-scrap-total'
    );
  });

  it('5.56 ammo value uses median of (relative cost total / item qty), not cost-each / qty', () => {
    const RIFLE_AMMO = -1211166256;
    const SULFUR = -151838493;
    const names = {
      ...ITEM_NAMES,
      [String(RIFLE_AMMO)]: { name: '5.56 Rifle Ammo', short: 'ammo.rifle' },
      [String(SULFUR)]: { name: 'Sulfur', short: 'sulfur' }
    };
    const machines = [
      machine(1, [
        listing(RIFLE_AMMO, SULFUR, 290, 20, 1),
        listing(RIFLE_AMMO, SULFUR, 290, 20, 2)
      ]),
      machine(2, [
        listing(SULFUR, SCRAP, 10, 100, 3),
        listing(SULFUR, SCRAP, 10, 100, 4),
        listing(SULFUR, SCRAP, 10, 100, 5)
      ])
    ];
    const { machines: enriched } = enrichOffersWithRelativeCost(machines, names);
    const ammo = enriched[0].sellOrders[0];
    assert.equal(ammo.relativeCost, 29);
    assert.ok(ammo.relativeValueUnitPrice > 0.1);
    assert.ok(ammo.relativeValueUnitPrice < 2);
    assert.equal(ammo.relativeValue, ammo.relativeValueUnitPrice * 20);
    assert.notEqual(ammo.relativeValueUnitPrice, ammo.relativeCostUnitPrice / 20);
    assert.equal(ammo._valueCacheSource, 'payment-listings-median');
  });

  it('1000 wood for 20 scrap — value 20 total and 0.02 each (not 20 each)', () => {
    const machines = [machine(1, [listing(WOOD, SCRAP, 20, 1000, 1)])];
    const { machines: enriched } = enrichOffersWithRelativeCost(machines, ITEM_NAMES);
    const wood = enriched[0].sellOrders[0];
    assert.equal(wood.relativeValue, 20);
    assert.equal(wood.relativeValueUnitPrice, 0.02);
    assert.equal(wood.relativeCost, 20);
  });

  it('wood and HQM relative value: total = cost, each = cost / item qty', () => {
    const machines = [
      machine(1, [
        listing(WOOD, SCRAP, 50, 1, 1),
        listing(WOOD, SCRAP, 50, 1, 2),
        listing(WOOD, SCRAP, 50, 1, 3)
      ]),
      machine(2, [
        listing(HQM, SCRAP, 50, 1, 4),
        listing(HQM, SCRAP, 50, 1, 5),
        listing(HQM, SCRAP, 50, 1, 6)
      ]),
      machine(3, [listing(HQM, SCRAP, 50, 1000, 7)])
    ];
    const { machines: enriched } = enrichOffersWithRelativeCost(machines, ITEM_NAMES);
    const wood = enriched[0].sellOrders[0];
    const hqm = enriched[1].sellOrders[0];
    const hqmBulk = enriched[2].sellOrders[0];
    assert.equal(wood.relativeValueUnitPrice, 50);
    assert.equal(hqm.relativeValueUnitPrice, 50);
    assert.equal(wood.relativeValue, 50);
    assert.equal(hqm.relativeValue, 50);
    assert.equal(hqmBulk.relativeValueUnitPrice, 0.05);
    assert.equal(hqmBulk.relativeValue, 50);
  });

  it('values metal fragments stack-total scrap listings without inflating to millions', () => {
    const machines = [
      machine(1, [listing(METAL_FRAGMENTS, SCRAP, 1250, 1000, 1)]),
      machine(2, [listing(METAL_FRAGMENTS, SCRAP, 625, 500, 2)]),
      machine(3, [listing(METAL_FRAGMENTS, SCRAP, 2500, 2000, 3)])
    ];
    const { machines: enriched } = enrichOffersWithRelativeCost(machines, ITEM_NAMES);
    const mf = enriched[0].sellOrders[0];
    assert.equal(mf._pricingModel, 'stack-total');
    assert.equal(mf.relativeValue, 1250);
    assert.equal(mf.relativeValueUnitPrice, 1.25);
    assert.equal(mf.relativeCost, 1250);
    assert.equal(mf.relativeCostUnitPrice, 1);
  });

  it('relative cost uses cost qty only, not item qty', () => {
    const order = listing(BLUEPRINT, SCRAP, 10, 5, 1);
    const cache = new Map();
    cache.set(BLUEPRINT, { baseValue: 1, pathDepth: 0, confidence: 'high' });
    const enriched = enrichSingleOffer(order, SCRAP, 'Scrap', cache);
    assert.equal(enriched.relativeCost, 10);
    assert.equal(enriched.relativeCostUnitPrice, 1);
    assert.equal(enriched.relativeValue, 10);
    assert.equal(enriched.relativeValueUnitPrice, 2);
  });

  it('builds reliable edges when marker ids are zero using shop position', () => {
    const machines = [
      { id: 0, x: 100, y: 200, name: 'A', sellOrders: [listing(BLUEPRINT, SCRAP, 100, 1)] },
      { id: 0, x: 300, y: 200, name: 'B', sellOrders: [listing(BLUEPRINT, SCRAP, 100, 1)] },
      { id: 0, x: 500, y: 200, name: 'C', sellOrders: [listing(BLUEPRINT, SCRAP, 102, 1)] }
    ];
    const flat = flattenOffers(machines);
    const edges = buildReliableExchangeEdges(flat);
    assert.equal(edges.size, 1);
    assert.equal(edges.get(`${BLUEPRINT}:${SCRAP}`).sampleCount, 3);
  });

  it('infers currency to base via items listed in both currencies', () => {
    const machines = [
      { id: 0, x: 10, y: 10, sellOrders: [listing(BLUEPRINT, HQM, 10, 1)] },
      { id: 0, x: 20, y: 20, sellOrders: [listing(BLUEPRINT, HQM, 10, 1)] },
      { id: 0, x: 30, y: 30, sellOrders: [listing(BLUEPRINT, HQM, 10, 1)] },
      { id: 0, x: 40, y: 40, sellOrders: [listing(BLUEPRINT, SCRAP, 500, 1)] },
      { id: 0, x: 50, y: 50, sellOrders: [listing(BLUEPRINT, SCRAP, 500, 1)] },
      { id: 0, x: 60, y: 60, sellOrders: [listing(BLUEPRINT, SCRAP, 500, 1)] },
      { id: 0, x: 70, y: 70, sellOrders: [listing(BLUEPRINT, HQM, 10, 1)] },
      { id: 0, x: 80, y: 80, sellOrders: [listing(WOOD, SCRAP, 50, 1)] },
      { id: 0, x: 90, y: 90, sellOrders: [listing(WOOD, SCRAP, 50, 1)] },
      { id: 0, x: 100, y: 100, sellOrders: [listing(WOOD, SCRAP, 50, 1)] }
    ];
    const { machines: enriched, marketContext } = enrichOffersWithRelativeCost(machines, ITEM_NAMES);
    assert.equal(marketContext.selectedBaseCurrencyItemId, SCRAP);

    const bpHqm = enriched.find(m => m.x === 70).sellOrders[0];
    assert.equal(bpHqm.marketRateSource, 'derived');
    assert.equal(bpHqm.relativeCost, 500);
  });

  it('leaves relative cost blank when payment currency base value is invalid', () => {
    const cache = new Map();
    cache.set(METAL_FRAGMENTS, { baseValue: 0, pathDepth: 2, confidence: 'low' });
    const offer = enrichSingleOffer(
      listing(WOOD, METAL_FRAGMENTS, 20, 1),
      SCRAP,
      'Scrap',
      cache
    );
    assert.equal(offer.marketRateSource, null);
    assert.equal(offer.relativeCost, null);
  });

  it('leaves relative cost blank when derived total rounds below display threshold', () => {
    const cache = new Map();
    cache.set(METAL_FRAGMENTS, { baseValue: 0.0002, pathDepth: 2, confidence: 'low' });
    const offer = enrichSingleOffer(
      listing(WOOD, METAL_FRAGMENTS, 20, 1),
      SCRAP,
      'Scrap',
      cache
    );
    assert.equal(offer.marketRateSource, null);
    assert.equal(offer.relativeCost, null);
  });

  it('shows relative cost for bulk stacks when total is meaningful', () => {
    const cache = new Map();
    cache.set(METAL_FRAGMENTS, { baseValue: 0.1, pathDepth: 1, confidence: 'medium' });
    const offer = enrichSingleOffer(
      listing(WOOD, METAL_FRAGMENTS, 100, 10000),
      SCRAP,
      'Scrap',
      cache
    );
    assert.equal(offer.marketRateSource, 'derived');
    assert.equal(offer.relativeCost, 10);
    assert.equal(offer.relativeCostUnitPrice, 0.1);
  });

  it('values payment currency from buy listings (cctv sold for sulfur ore)', () => {
    const CCTV = 634478325;
    const SULFUR_ORE = -1157596551;
    const names = {
      ...ITEM_NAMES,
      [String(CCTV)]: { name: 'CCTV Camera', short: 'cctv.camera' },
      [String(SULFUR_ORE)]: { name: 'Sulfur Ore', short: 'sulfur.ore' }
    };
    const machines = [
      machine(1, [listing(SULFUR_ORE, SCRAP, 100, 1000), listing(SULFUR_ORE, SCRAP, 100, 1000)]),
      machine(2, [listing(SULFUR_ORE, SCRAP, 100, 1000)]),
      machine(3, [listing(CCTV, SULFUR_ORE, 500, 1)]),
      machine(4, [listing(BLUEPRINT, CCTV, 1, 1)])
    ];
    const { machines: enriched } = enrichOffersWithRelativeCost(machines, names);
    const bpCctv = enriched.find(m => m.id === 4).sellOrders[0];
    assert.equal(bpCctv.relativeCost, 50);
    assert.equal(bpCctv.relativeCostUnitPrice, 50);
  });

  it('prefers scrap over sewing kit when scores are close', () => {
    const SEWING_KIT = 1234880403;
    const names = {
      ...ITEM_NAMES,
      [String(SEWING_KIT)]: { name: 'Sewing Kit', short: 'sewingkit' }
    };
    const machines = [
      machine(1, [listing(BLUEPRINT, SCRAP, 50, 1), listing(BLUEPRINT, SCRAP, 50, 1)]),
      machine(2, [listing(BLUEPRINT, SCRAP, 50, 1)]),
      machine(3, [listing(BLUEPRINT, SEWING_KIT, 1, 1), listing(BLUEPRINT, SEWING_KIT, 1, 1)]),
      machine(4, [listing(WOOD, SEWING_KIT, 1, 1)])
    ];
    const { marketContext } = enrichOffersWithRelativeCost(machines, names);
    assert.equal(marketContext.selectedBaseCurrencyItemId, SCRAP);
  });

  it('values sewing kit when same item is listed in scrap and sewing kit', () => {
    const SEWING_KIT = 1234880403;
    const names = {
      ...ITEM_NAMES,
      [String(SEWING_KIT)]: { name: 'Sewing Kit', short: 'sewingkit' }
    };
    const machines = [
      machine(1, [listing(BLUEPRINT, SCRAP, 50, 1), listing(BLUEPRINT, SCRAP, 50, 1)]),
      machine(2, [listing(BLUEPRINT, SCRAP, 50, 1)]),
      machine(3, [listing(BLUEPRINT, SEWING_KIT, 1, 1), listing(BLUEPRINT, SEWING_KIT, 1, 1)]),
      machine(4, [listing(WOOD, SEWING_KIT, 1, 1)])
    ];
    const { machines: enriched } = enrichOffersWithRelativeCost(machines, names);
    const wood = enriched.find(m => m.id === 4).sellOrders[0];
    assert.ok(wood.marketRateSource);
    assert.equal(wood.relativeCost, 50);
  });

  it('relative value for scrap-priced ore: total = cost, each = cost / item qty', () => {
    const SULFUR_ORE = -1157596551;
    const names = {
      ...ITEM_NAMES,
      [String(SULFUR_ORE)]: { name: 'Sulfur Ore', short: 'sulfur.ore' }
    };
    const machines = [
      machine(1, [listing(SULFUR_ORE, SCRAP, 100, 1000), listing(SULFUR_ORE, SCRAP, 100, 1000)]),
      machine(2, [listing(SULFUR_ORE, SCRAP, 100, 1000)])
    ];
    const { machines: enriched } = enrichOffersWithRelativeCost(machines, names);
    const ore = enriched[0].sellOrders[0];
    assert.equal(ore.relativeValue, 100);
    assert.equal(ore.relativeValueUnitPrice, 0.1);
    assert.equal(ore.relativeCost, 100);
    assert.equal(ore.relativeCostUnitPrice, 1);
    assert.equal(ore.relativeSpread, 0);
  });

  it('relative value for base item uses item qty as total', () => {
    const machines = [
      machine(1, [
        ...scrapPaymentListings(BLUEPRINT, 100, 1, [1, 2, 3]),
        ...scrapPaymentListings(WOOD, 50, 1, [4, 5, 6]),
        listing(SCRAP, HQM, 5, 500, 7),
        listing(SCRAP, HQM, 5, 500, 8)
      ]),
      machine(2, [listing(SCRAP, HQM, 5, 500, 9)])
    ];
    const { machines: enriched, marketContext } = enrichOffersWithRelativeCost(machines, ITEM_NAMES);
    assert.equal(marketContext.selectedBaseCurrencyItemId, SCRAP);
    const scrap = enriched[0].sellOrders.find(o => o.itemId === SCRAP);
    assert.equal(scrap.relativeValue, 500);
    assert.equal(scrap.relativeValueUnitPrice, 1);
  });

  it('relative value via item-cross when sold in non-base currency', () => {
    const SEWING_KIT = -1108134349;
    const names = {
      ...ITEM_NAMES,
      [String(SEWING_KIT)]: { name: 'Sewing Kit', short: 'sewingkit' }
    };
    const machines = [
      machine(1, [listing(BLUEPRINT, SCRAP, 100, 1), listing(BLUEPRINT, SCRAP, 100, 1)]),
      machine(2, [listing(BLUEPRINT, SEWING_KIT, 1, 1)]),
      machine(3, [listing(BLUEPRINT, SCRAP, 100, 1)])
    ];
    const { machines: enriched } = enrichOffersWithRelativeCost(machines, names);
    const bpSk = enriched.find(m => m.id === 2).sellOrders[0];
    assert.equal(bpSk.relativeValue, 100);
    assert.equal(bpSk.relativeValueUnitPrice, 100);
  });

  it('shows relative value for sub-cent blueprint stack totals', () => {
    const BASIC_BP = -143481979;
    const names = {
      ...ITEM_NAMES,
      [String(BASIC_BP)]: { name: 'Basic Blueprint Fragment', short: 'basicblueprint' }
    };
    const cache = new Map();
    cache.set(BASIC_BP, {
      baseValue: 0.0011796805407072368,
      pathDepth: 0,
      confidence: 'high',
      sampleCount: 23,
      viaBuyOffers: true
    });
    const offer = listing(BASIC_BP, WOOD, 1200, 5, 1);
    const enriched = enrichSingleOffer(offer, SCRAP, 'Scrap', cache, new Map(), new Map());
    assert.ok(enriched.relativeValue > 0);
    assert.ok(enriched.relativeValue < 0.01);
    assert.equal(enriched.relativeValueUnitPrice, cache.get(BASIC_BP).baseValue);
    assert.equal(enriched.relativeValue, offer.quantity * cache.get(BASIC_BP).baseValue);
  });

  it('relative value from payment-role when item is only used as currency elsewhere', () => {
    const machines = [
      machine(1, [...scrapPaymentListings(WOOD, 50, 1, [1, 2, 3])]),
      machine(2, [listing(WOOD, BLUEPRINT, 5, 1), listing(WOOD, BLUEPRINT, 5, 1)]),
      machine(3, [listing(BLUEPRINT, WOOD, 10, 1)])
    ];
    const { machines: enriched } = enrichOffersWithRelativeCost(machines, ITEM_NAMES);
    const bpWood = enriched.find(m => m.id === 3).sellOrders[0];
    assert.ok(bpWood.relativeValue != null && bpWood.relativeValue > 0);
    assert.ok(bpWood.relativeValueUnitPrice != null && bpWood.relativeValueUnitPrice > 0);
  });

  it('relative value scales with item qty while unit stays stable', () => {
    const PAY = 999002;
    const names = {
      ...ITEM_NAMES,
      [String(PAY)]: { name: 'CCTV Camera', short: 'cctv' }
    };
    const cache = new Map();
    cache.set(PAY, { baseValue: 250, pathDepth: 1, confidence: 'medium' });
    cache.set(BLUEPRINT, { baseValue: 400, pathDepth: 0, confidence: 'high' });
    const oneBp = enrichSingleOffer(listing(BLUEPRINT, PAY, 1, 1), SCRAP, 'Scrap', cache);
    const twoBp = enrichSingleOffer(listing(BLUEPRINT, PAY, 1, 2), SCRAP, 'Scrap', cache);
    assert.equal(oneBp.relativeValue, 400);
    assert.equal(twoBp.relativeValue, 800);
    assert.equal(oneBp.relativeValueUnitPrice, 400);
    assert.equal(twoBp.relativeValueUnitPrice, 400);
    assert.equal(oneBp.relativeSpread, 150);
    assert.equal(twoBp.relativeSpread, 550);
  });

  it('relative spread equals relative value minus relative cost when both known', () => {
    const machines = [
      machine(1, [listing(WOOD, SCRAP, 50, 1), listing(WOOD, SCRAP, 50, 1)]),
      machine(2, [listing(WOOD, SCRAP, 50, 1)])
    ];
    const { machines: enriched } = enrichOffersWithRelativeCost(machines, ITEM_NAMES);
    const wood = enriched[0].sellOrders[0];
    assert.ok(wood.relativeValue != null && wood.relativeCost != null);
    assert.equal(wood.relativeSpread, wood.relativeValue - wood.relativeCost);
  });

  it('relative cost uses cost qty only; stable across sold item qty', () => {
    const PAY = 999002;
    const names = {
      ...ITEM_NAMES,
      [String(PAY)]: { name: 'CCTV Camera', short: 'cctv' }
    };
    const cache = new Map();
    cache.set(PAY, { baseValue: 250, pathDepth: 1, confidence: 'medium' });
    const oneBp = enrichSingleOffer(listing(BLUEPRINT, PAY, 1, 1), SCRAP, 'Scrap', cache);
    const twoBp = enrichSingleOffer(listing(BLUEPRINT, PAY, 1, 2), SCRAP, 'Scrap', cache);
    const charcoal = enrichSingleOffer(listing(WOOD, PAY, 1, 1000), SCRAP, 'Scrap', cache);
    assert.equal(oneBp.relativeCost, 250);
    assert.equal(twoBp.relativeCost, 250);
    assert.equal(charcoal.relativeCost, 250);
    assert.equal(oneBp.relativeCostUnitPrice, 250);
    assert.equal(twoBp.relativeCostUnitPrice, 250);
    assert.equal(charcoal.relativeCostUnitPrice, 250);
  });

  it('uses direct scrap listings to bridge payment currencies for common ore', () => {
    const SULFUR_ORE = -1157596551;
    const names = {
      ...ITEM_NAMES,
      [String(SULFUR_ORE)]: { name: 'Sulfur Ore', short: 'sulfur.ore' }
    };
    const machines = [
      machine(1, [listing(SULFUR_ORE, SCRAP, 100, 1000), listing(SULFUR_ORE, SCRAP, 100, 1000)]),
      machine(2, [listing(SULFUR_ORE, SCRAP, 100, 1000)]),
      machine(3, [listing(SULFUR_ORE, METAL_FRAGMENTS, 50, 1000)])
    ];
    const { machines: enriched } = enrichOffersWithRelativeCost(machines, names);
    const oreMf = enriched.find(m => m.id === 3).sellOrders[0];
    assert.equal(oreMf.marketRateSource, 'derived');
    assert.equal(oreMf.relativeCost, 100);
    assert.equal(oreMf.relativeCostUnitPrice, 2);
  });

  it('derives crude oil relative cost via same-item scrap and payment cross rate', () => {
    const CRUDE_OIL = -321733511;
    const names = {
      ...ITEM_NAMES,
      [String(CRUDE_OIL)]: { name: 'Crude Oil', short: 'crude.oil' }
    };
    const machines = [
      machine(1, [listing(CRUDE_OIL, SCRAP, 6, 500), listing(CRUDE_OIL, SCRAP, 6, 500)]),
      machine(2, [listing(CRUDE_OIL, SCRAP, 6, 500)]),
      machine(3, [listing(CRUDE_OIL, METAL_FRAGMENTS, 10, 500)])
    ];
    const { machines: enriched } = enrichOffersWithRelativeCost(machines, names);
    const oilMf = enriched.find(m => m.id === 3).sellOrders[0];
    assert.ok(oilMf.marketRateSource === 'derived' || oilMf.marketRateSource === 'item-cross');
    assert.equal(oilMf.relativeCost, 6);
    assert.equal(oilMf.relativeCostUnitPrice, 0.6);
  });

  it('infers metal fragments via sold items without dual-listed scrap+mf', () => {
    const CHARCOAL = -1938051535;
    const machines = [
      machine(1, [listing(CHARCOAL, SCRAP, 50, 1), listing(CHARCOAL, SCRAP, 50, 1)]),
      machine(2, [listing(CHARCOAL, SCRAP, 50, 1)]),
      machine(3, [listing(CHARCOAL, METAL_FRAGMENTS, 100, 1)]),
      machine(4, [listing(WOOD, METAL_FRAGMENTS, 20, 1)])
    ];
    const { machines: enriched } = enrichOffersWithRelativeCost(machines, ITEM_NAMES);
    const woodMf = enriched.find(m => m.id === 4).sellOrders[0];
    assert.equal(woodMf.marketRateSource, 'derived');
    assert.equal(woodMf.relativeCost, 10);
    assert.equal(woodMf.relativeCostUnitPrice, 0.5);
  });

  it('infers metal fragments to scrap via a single dual-listed bridge item', () => {
    const machines = [
      machine(1, [listing(SULFUR, METAL_FRAGMENTS, 50, 1), listing(SULFUR, METAL_FRAGMENTS, 50, 1)]),
      machine(2, [listing(SULFUR, SCRAP, 500, 1), listing(SULFUR, SCRAP, 500, 1)]),
      machine(3, [listing(SULFUR, SCRAP, 500, 1)]),
      machine(10, [listing(WOOD, SCRAP, 50, 1)]),
      machine(11, [listing(WOOD, SCRAP, 50, 1)]),
      machine(12, [listing(WOOD, SCRAP, 50, 1)]),
      machine(4, [listing(BLUEPRINT, METAL_FRAGMENTS, 10, 1)])
    ];
    const flat = flattenOffers(machines);
    const implied = buildImpliedCurrencyToBaseEdgesFromOffers(flat, SCRAP);
    assert.ok(implied.has(`${METAL_FRAGMENTS}:${SCRAP}`));
    assert.equal(implied.get(`${METAL_FRAGMENTS}:${SCRAP}`).medianRate, 10);

    const { machines: enriched, marketContext } = enrichOffersWithRelativeCost(machines, ITEM_NAMES);
    assert.equal(marketContext.selectedBaseCurrencyItemId, SCRAP);
    const bpMf = enriched.find(m => m.id === 4).sellOrders[0];
    assert.equal(bpMf.marketRateSource, 'derived');
    assert.equal(bpMf.relativeCost, 100);
    assert.equal(bpMf.relativeCostUnitPrice, 10);
  });

  it('resolves via reverse edges when payment currency is not sold for base', () => {
    const machines = [
      machine(1, [listing(BLUEPRINT, HQM, 10, 1, 1)]),
      machine(2, [listing(BLUEPRINT, HQM, 10, 1, 2)]),
      machine(3, [listing(BLUEPRINT, HQM, 10, 1, 3)]),
      machine(4, [listing(BLUEPRINT, SCRAP, 500, 1, 4)]),
      machine(5, [listing(BLUEPRINT, SCRAP, 500, 1, 5)]),
      machine(6, [listing(BLUEPRINT, SCRAP, 500, 1, 6)]),
      machine(10, [listing(WOOD, SCRAP, 50, 1, 10)]),
      machine(11, [listing(WOOD, SCRAP, 50, 1, 11)]),
      machine(12, [listing(WOOD, SCRAP, 50, 1, 12)]),
      machine(7, [
        listing(WOOD, HQM, 20, 1, 7),
        listing(WOOD, HQM, 20, 1, 8),
        listing(WOOD, SCRAP, 50, 1, 9)
      ])
    ];
    const { machines: enriched, marketContext } = enrichOffersWithRelativeCost(machines, ITEM_NAMES);
    assert.equal(marketContext.selectedBaseCurrencyItemId, SCRAP);

    const woodOffer = enriched.find(m => m.id === 7).sellOrders[0];
    assert.equal(woodOffer.marketRateSource, 'derived');
    assert.ok(woodOffer.relativeCost > 0);
  });

  it('7. unavailable relative unit sorts last', () => {
    assert.equal(compareRelativeCostUnit('', '10', 'asc'), 1);
    assert.equal(compareRelativeCostUnit('10', '', 'asc'), -1);
    assert.equal(compareRelativeCostUnit('', '10', 'desc'), 1);
    assert.equal(compareRelativeCostUnit('5', '10', 'asc'), -5);
    assert.equal(compareRelativeValueUnit('', '10', 'asc'), 1);
    assert.equal(compareRelativeValueUnit('10', '', 'asc'), -1);
    assert.equal(compareRelativeSpread('', '10', 'asc'), 1);
    assert.equal(compareRelativeSpread('10', '', 'asc'), -1);
    assert.equal(compareRelativeSpread('20', '5', 'desc'), -15);
  });

  it('uses HQM as base when only HQM economy exists', () => {
    const machines = [
      machine(1, [
        listing(BLUEPRINT, HQM, 10, 1, 1),
        listing(WOOD, HQM, 5, 1, 2)
      ]),
      machine(2, [
        listing(BLUEPRINT, HQM, 10, 1, 3),
        listing(WOOD, HQM, 5, 1, 4)
      ]),
      machine(3, scrapPaymentListings(BLUEPRINT, 500, 1, [5, 6, 7]))
    ];
    const offers = flattenOffers(machines);
    const base = selectBaseCurrency(offers, SCRAP);
    assert.equal(base.itemId, HQM);

    const { machines: enriched, marketContext } = enrichOffersWithRelativeCost(machines, ITEM_NAMES);
    assert.equal(marketContext.selectedBaseCurrencyName, 'High Quality Metal');

    const bpHqm = enriched[0].sellOrders.find(o => o.currencyId === HQM);
    assert.equal(bpHqm.relativeCost, 10);
    assert.equal(bpHqm.marketRateSource, 'base-direct');
    assert.match(bpHqm.relativeCostCurrency, /High Quality Metal/);
  });

  it('rejects unreliable direct edges with extreme spread', () => {
    const offers = [
      listing(HQM, SCRAP, 10, 1, 1),
      listing(HQM, SCRAP, 20, 1, 2),
      listing(HQM, SCRAP, 100, 1, 3)
    ];
    const edges = buildReliableExchangeEdges(offers);
    assert.equal(edges.size, 0);
  });
});

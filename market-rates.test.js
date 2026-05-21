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
  compareRelativeCostUnit,
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
  });

  it('4. leaves relative cost blank when no path to base exists', () => {
    const machines = [
      machine(1, scrapPaymentListings(HQM, 50, 1, [1, 2, 3])),
      machine(2, [listing(BLUEPRINT, WOOD, 100, 1, 4)])
    ];
    const { machines: enriched } = enrichOffersWithRelativeCost(machines, ITEM_NAMES);
    const isolated = enriched[1].sellOrders[0];
    assert.equal(isolated.relativeCost, null);
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
    assert.equal(enriched.marketRateSource, 'base-direct');
    assert.equal(enriched.pathDepth, 0);
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
    assert.equal(offer.relativeCostUnitPrice, 0.001);
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

  it('relative cost matches for same cost regardless of sold item qty', () => {
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
    assert.equal(twoBp.relativeCostUnitPrice, 125);
    assert.equal(charcoal.relativeCostUnitPrice, 0.25);
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
    assert.equal(oreMf.relativeCostUnitPrice, 0.1);
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
    assert.equal(oilMf.relativeCostUnitPrice, 0.012);
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
    assert.equal(woodMf.relativeCostUnitPrice, 10);
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
    assert.equal(bpMf.relativeCostUnitPrice, 100);
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

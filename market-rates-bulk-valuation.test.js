const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  SCRAP_ITEM_ID_FALLBACK,
  HQM_ITEM_ID,
  enrichOffersWithRelativeCost,
  scrapRatePerSoldItem,
  buildItemCurrencyPricingModels,
  attachPricingModels
} = require('./market-rates');

const SCRAP = SCRAP_ITEM_ID_FALLBACK;
const HQM = HQM_ITEM_ID;
const WOOD = -1461508848;
const METAL_FRAGMENTS = 69511070;

const ITEM_NAMES = {
  [String(SCRAP)]: { name: 'Scrap', short: 'scrap' },
  [String(HQM)]: { name: 'High Quality Metal', short: 'metal.hq' },
  [String(WOOD)]: { name: 'Wood', short: 'wood' }
};

function listing(itemId, currencyId, cost, qty, machineId) {
  return {
    itemId,
    currencyId,
    costPerItem: cost,
    quantity: qty,
    amountInStock: 100,
    machineId
  };
}

function machine(id, orders) {
  return { id, name: `Shop ${id}`, x: id, y: 0, sellOrders: orders };
}

describe('bulk item qty vs scrap rate per sold item', () => {
  it('1000 wood for 20 scrap — rate is 0.02 each (cost is total for stack)', () => {
    const o = listing(WOOD, SCRAP, 20, 1000, 1);
    o._pricingModel = 'per-item';
    assert.equal(scrapRatePerSoldItem(o), 0.02);
  });

  it('enriched wood row: relative value 20 total and 0.02 each', () => {
    const machines = [machine(1, [listing(WOOD, SCRAP, 20, 1000, 1)])];
    const { machines: enriched } = enrichOffersWithRelativeCost(machines, ITEM_NAMES);
    const wood = enriched[0].sellOrders[0];
    assert.equal(wood.relativeValue, 20);
    assert.equal(wood.relativeValueUnitPrice, 0.02);
    assert.equal(wood._valueCacheSource, 'listing-scrap-total');
  });

  it('1000 stone for 50 scrap — value 50 total and 0.05 each', () => {
    const STONES = -2099697608;
    const machines = [machine(1, [listing(STONES, SCRAP, 50, 1000, 1)])];
    const names = {
      ...ITEM_NAMES,
      [String(STONES)]: { name: 'Stones', short: 'stones' }
    };
    const { machines: enriched } = enrichOffersWithRelativeCost(machines, names);
    const stone = enriched[0].sellOrders[0];
    assert.equal(stone.relativeValue, 50);
    assert.equal(stone.relativeValueUnitPrice, 0.05);
  });

  it('wood piles at ~1–2 scrap and HQM stacks at ~50 scrap — HQM each much higher than wood', () => {
    const machines = [
      machine(1, [
        listing(WOOD, SCRAP, 1, 1000, 1),
        listing(WOOD, SCRAP, 1, 1000, 2),
        listing(WOOD, SCRAP, 2, 1000, 3)
      ]),
      machine(2, [
        listing(WOOD, SCRAP, 1, 500, 4),
        listing(WOOD, SCRAP, 2, 500, 5)
      ]),
      machine(3, [
        listing(HQM, SCRAP, 50, 1, 6),
        listing(HQM, SCRAP, 55, 1, 7),
        listing(HQM, SCRAP, 48, 1, 8)
      ]),
      machine(4, [listing(HQM, SCRAP, 52, 20, 9)]),
      machine(5, [listing(WOOD, HQM, 50, 1000, 10), listing(HQM, WOOD, 100, 10, 11)])
    ];
    const { machines: enriched } = enrichOffersWithRelativeCost(machines, ITEM_NAMES);
    const wood = enriched[0].sellOrders[0];
    const hqm = enriched[2].sellOrders[0];
    assert.ok(wood.relativeValueUnitPrice <= 3);
    assert.ok(hqm.relativeValueUnitPrice >= 45);
    assert.ok(hqm.relativeValueUnitPrice > wood.relativeValueUnitPrice * 10);
    assert.equal(wood.relativeValue, wood.relativeValueUnitPrice * wood.quantity);
    assert.equal(hqm.relativeValue, hqm.relativeValueUnitPrice * hqm.quantity);
  });

  it('proportional stack-total listings use cost divided by item qty', () => {
    const offers = [
      listing(METAL_FRAGMENTS, SCRAP, 1250, 1000, 1),
      listing(METAL_FRAGMENTS, SCRAP, 625, 500, 2)
    ];
    const models = buildItemCurrencyPricingModels(offers);
    offers.forEach(o => {
      o._pricingModel = models.get(`${METAL_FRAGMENTS}:${SCRAP}`) ?? 'per-item';
    });
    assert.equal(scrapRatePerSoldItem(offers[0]), 1.25);
    assert.equal(scrapRatePerSoldItem(offers[1]), 1.25);
  });
});

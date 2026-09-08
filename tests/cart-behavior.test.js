const test = require('node:test');
const assert = require('node:assert/strict');
const cartState = require('../public/cart-state');

test('loose products aggregate by product/variant and quantity controls update totals', () => {
  let cart = [];
  const disc = { id: 'part-disc-145', name: 'Δίσκος 145mm', price: 4, stock: 3 };
  cart = cartState.add(cart, disc);
  assert.equal(cart.length, 1);
  assert.equal(cart[0].qty, 1);
  assert.equal(cart[0].builderSnapshot, undefined);
  cart = cartState.add(cart, disc);
  assert.equal(cart.length, 1);
  assert.equal(cart[0].qty, 2);
  assert.equal(cartState.subtotal(cart), 8);
  assert.equal(cartState.badgeCount(cart), 2);
  cart = cartState.change(cart, 'part-disc-145', -1);
  assert.equal(cart[0].qty, 1);
  assert.equal(cartState.subtotal(cart), 4);
  cart = cartState.change(cart, 'part-disc-145', -1);
  assert.deepEqual(cart, []);
});

test('loose variants remain separate, stock caps increments, and serialized quantity survives reload', () => {
  let cart = cartState.add([], { id: 'stopper', variantId: 'white', price: 2, stock: 2 });
  cart = cartState.add(cart, { id: 'stopper', variantId: 'black', price: 3, stock: 4 });
  cart = cartState.add(cart, { id: 'stopper', variantId: 'white', price: 2, stock: 2 });
  cart = cartState.add(cart, { id: 'stopper', variantId: 'white', price: 2, stock: 2 });
  assert.equal(cart.length, 2);
  assert.equal(cart.find((item) => item.variantId === 'white').qty, 2);
  const reloaded = JSON.parse(JSON.stringify(cart));
  assert.equal(cartState.badgeCount(reloaded), 3);
  assert.equal(cartState.subtotal(reloaded), 7);
});

test('configured kit is one visible atomic line and quantity changes preserve its children and snapshot', () => {
  const key = 'roll::sbs::color=white&left=skip::summary';
  const snapshot = Object.freeze({ version: 1, total: 12, steps: Object.freeze([{ stepId: 'color', optionId: 'white' }]) });
  let cart = [];
  cart = cartState.add(cart, { id: 'part-white', price: 8, cartKey: `${key}::component:color`, sourceKitCartKey: key });
  cart = cartState.add(cart, { id: 'part-strap', price: 4, cartKey: `${key}::component:strap`, sourceKitCartKey: key });
  cart = cartState.add(cart, { id: 'roll', price: 0, cartKey: key, isKitSummary: true, builderSnapshot: snapshot });
  assert.equal(cartState.visibleItems(cart).length, 1);
  assert.equal(cartState.badgeCount(cart), 1);
  const originalSnapshot = JSON.stringify(cart.find((item) => item.cartKey === key).builderSnapshot);
  cart = cartState.change(cart, key, 1);
  assert.ok(cart.every((item) => item.qty === 2));
  assert.equal(cartState.badgeCount(cart), 2);
  assert.equal(cartState.subtotal(cart), 24);
  assert.equal(JSON.stringify(cart.find((item) => item.cartKey === key)?.builderSnapshot || cart.find((item) => item.cartKey === key).builderSnapshot), originalSnapshot);
  cart = cartState.change(cart, key, -1);
  assert.ok(cart.every((item) => item.qty === 1));
  cart = cartState.change(cart, key, -1);
  assert.deepEqual(cart, []);
});

test('differently configured kits remain separate atomic lines', () => {
  let cart = [];
  for (const key of ['roll::color=white::summary', 'roll::color=black::summary']) {
    cart = cartState.add(cart, { id: `part-${key}`, price: 10, cartKey: `${key}::component:color`, sourceKitCartKey: key });
    cart = cartState.add(cart, { id: 'roll', price: 0, cartKey: key, isKitSummary: true, builderSnapshot: { version: 1, total: 10, steps: [] } });
  }
  assert.equal(cartState.visibleItems(cart).length, 2);
  cart = cartState.removeLine(cart, 'roll::color=white::summary');
  assert.equal(cartState.visibleItems(cart).length, 1);
  assert.equal(cartState.visibleItems(cart)[0].cartKey, 'roll::color=black::summary');
  assert.ok(cart.every((item) => item.sourceKitCartKey !== 'roll::color=white::summary'));
});

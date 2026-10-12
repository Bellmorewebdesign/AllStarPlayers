import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFulfillment, zoneForAddress, shippingCharge, squareRecipient } from '../lib/fulfillment.mjs';
import { settings } from '../lib/config.mjs';
import { withEnv, baseEnv } from './helpers.mjs';

const contact = { firstName: 'Dav', lastName: 'Capo', email: 'dav@example.com', phone: '718-505-1038' };
const nyAddress = { line1: '96-03 37th Ave', city: 'Queens', state: 'NY', postalCode: '11368', country: 'US' };

const s = (env = {}) => withEnv(baseEnv(env), () => settings());

test('pickup needs contact details and nothing else', () => {
  const r = validateFulfillment({ type: 'pickup', contact }, { settings: s(), subtotal: 5000 });
  assert.equal(r.ok, true);
  assert.equal(r.fulfillment.type, 'pickup');
  assert.equal(r.fulfillment.address, null);
  assert.match(r.fulfillment.policy, /contact you when your order is ready/i);
  assert.equal(r.fulfillment.pickupAddress, '96-03 37th Ave, Queens, NY 11368');
});

test('an unconfigured method is unavailable, not free', () => {
  const noPickup = s({ PICKUP_ENABLED: 'false' });
  const r = validateFulfillment({ type: 'pickup', contact }, { settings: noPickup, subtotal: 5000 });
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /not switched on/i);

  const noShipping = withEnv({ ...baseEnv(), SHIPPING_RATES: '' }, () => settings());
  const r2 = validateFulfillment({ type: 'shipping', contact, address: nyAddress }, { settings: noShipping, subtotal: 5000 });
  assert.equal(r2.ok, false);
  assert.match(r2.errors[0].message, /no shipping rates have been configured/i);
});

test('shipping picks the most specific configured zone', () => {
  const r = validateFulfillment({ type: 'shipping', contact, address: nyAddress }, { settings: s(), subtotal: 5000 });
  assert.equal(r.ok, true);
  assert.equal(r.fulfillment.zoneId, 'ny', 'the NY zone beats the catch-all US zone');
  assert.equal(r.fulfillment.shipping.amount, 800);

  const tx = validateFulfillment(
    { type: 'shipping', contact, address: { ...nyAddress, state: 'TX', city: 'Austin', postalCode: '73301' } },
    { settings: s(), subtotal: 5000 });
  assert.equal(tx.fulfillment.zoneId, 'us');
  assert.equal(tx.fulfillment.shipping.amount, 1400);
});

test('a free-shipping threshold is honoured, and only above it', () => {
  const under = validateFulfillment({ type: 'shipping', contact, address: nyAddress }, { settings: s(), subtotal: 14999 });
  assert.equal(under.fulfillment.shipping.amount, 800);
  const over = validateFulfillment({ type: 'shipping', contact, address: nyAddress }, { settings: s(), subtotal: 15000 });
  assert.equal(over.fulfillment.shipping.amount, 0);
  assert.equal(over.fulfillment.shipping.free, true);
});

test('bad addresses are rejected field by field', () => {
  const cases = [
    [{ ...nyAddress, line1: '' }, 'address.line1'],
    [{ ...nyAddress, city: '' }, 'address.city'],
    [{ ...nyAddress, state: 'ZZ' }, 'address.state'],
    [{ ...nyAddress, postalCode: 'abc' }, 'address.postalCode'],
    [{ ...nyAddress, country: 'FR' }, 'address.country']
  ];
  for (const [address, field] of cases) {
    const r = validateFulfillment({ type: 'shipping', contact, address }, { settings: s(), subtotal: 5000 });
    assert.equal(r.ok, false, field + ' should fail');
    assert.ok(r.errors.some(e => e.field === field), 'expected an error on ' + field + ', got ' + JSON.stringify(r.errors));
  }
});

test('contact details are checked for both methods', () => {
  for (const type of ['pickup', 'shipping']) {
    const r = validateFulfillment(
      { type, contact: { firstName: '', lastName: '', email: 'nope', phone: '12' }, address: nyAddress },
      { settings: s(), subtotal: 5000 });
    assert.equal(r.ok, false);
    const fields = r.errors.map(e => e.field);
    assert.ok(fields.includes('contact.firstName'));
    assert.ok(fields.includes('contact.email'));
    assert.ok(fields.includes('contact.phone'));
  }
});

test('an unknown fulfillment type is refused', () => {
  for (const type of [undefined, null, '', 'courier', 'local-delivery', 'dropship']) {
    const r = validateFulfillment({ type, contact }, { settings: s(), subtotal: 100 });
    assert.equal(r.ok, false);
  }
});

test('the Square recipient carries the validated address', () => {
  const r = validateFulfillment({ type: 'shipping', contact, address: nyAddress }, { settings: s(), subtotal: 100 });
  const rec = squareRecipient(r.fulfillment);
  assert.equal(rec.display_name, 'Dav Capo');
  assert.equal(rec.email_address, 'dav@example.com');
  assert.equal(rec.address.postal_code, '11368');
  assert.equal(rec.address.administrative_district_level_1, 'NY');
  assert.equal(rec.address.country, 'US');
});

test('a malformed SHIPPING_RATES switches shipping off instead of guessing', () => {
  const broken = withEnv({ ...baseEnv(), SHIPPING_RATES: 'not json at all' }, () => settings());
  assert.equal(broken.shipping.enabled, false);
  assert.deepEqual(broken.shipping.zones, []);
});

test('zone helpers behave on their own', () => {
  const zones = [{ id: 'a', label: 'A', amount: 500, currency: 'USD', countries: ['US'], states: ['NY'], freeOver: null }];
  assert.equal(zoneForAddress({ country: 'US', state: 'NY' }, zones).id, 'a');
  assert.equal(zoneForAddress({ country: 'US', state: 'CA' }, zones), null);
  assert.equal(shippingCharge(null, 0), null);
});

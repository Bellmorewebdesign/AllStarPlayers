/* ==========================================================================
   All Star Players / fulfillment
   --------------------------------------------------------------------------
   Two ways to get the goods, and they are configured separately:

     pickup    the customer collects from 96-03 37th Ave. Staff tell them when
               it is ready. No time is promised and no appointment is booked,
               because the shop has not agreed to either.

     shipping  a parcel goes out by carrier. The rate comes from the shop's
               own configured zones, never from the browser and never from a
               carrier API, because no carrier API is wired up. Nothing here
               produces a label, a tracking number or a live UPS rate.

   A method that is not configured is simply not offered. There is no silent
   fallback to free shipping and no default rate.
   ========================================================================== */

const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA',
  'ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR',
  'PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
  'AS','GU','MP','PR','VI','AA','AE','AP'
]);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function str(v, max = 200) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/* Everybody needs to be reachable, whichever method they pick: staff have to
   be able to say "it is ready" for pickup, and a carrier needs a phone for a
   parcel. */
function validateContact(raw) {
  const contact = {
    firstName: str(raw?.firstName, 60),
    lastName: str(raw?.lastName, 60),
    email: str(raw?.email, 120).toLowerCase(),
    phone: str(raw?.phone, 30)
  };
  const errors = [];
  if (!contact.firstName) errors.push({ field: 'contact.firstName', message: 'Enter a first name.' });
  if (!contact.lastName) errors.push({ field: 'contact.lastName', message: 'Enter a last name.' });
  if (!EMAIL.test(contact.email)) errors.push({ field: 'contact.email', message: 'Enter a valid email address.' });

  const digits = contact.phone.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) {
    errors.push({ field: 'contact.phone', message: 'Enter a phone number with at least 10 digits.' });
  }
  return { contact, errors };
}

function validateAddress(raw, zones) {
  const address = {
    line1: str(raw?.line1, 120),
    line2: str(raw?.line2, 120),
    city: str(raw?.city, 80),
    state: str(raw?.state, 20).toUpperCase(),
    postalCode: str(raw?.postalCode, 20).toUpperCase(),
    country: (str(raw?.country, 2) || 'US').toUpperCase()
  };
  const errors = [];
  if (!address.line1) errors.push({ field: 'address.line1', message: 'Enter a street address.' });
  if (!address.city) errors.push({ field: 'address.city', message: 'Enter a city.' });

  if (address.country === 'US') {
    if (!US_STATES.has(address.state)) {
      errors.push({ field: 'address.state', message: 'Enter a two-letter US state, like NY.' });
    }
    if (!/^\d{5}(-\d{4})?$/.test(address.postalCode)) {
      errors.push({ field: 'address.postalCode', message: 'Enter a ZIP code, like 11368.' });
    }
  } else {
    if (!address.postalCode) errors.push({ field: 'address.postalCode', message: 'Enter a postal code.' });
  }

  /* Only places the shop has priced can be shipped to. Anywhere else is
     refused outright rather than guessed at. */
  const countries = new Set(zones.flatMap(z => z.countries));
  if (!countries.has(address.country)) {
    errors.push({
      field: 'address.country',
      message: 'We do not ship to that country yet. ' +
        (countries.size ? 'We currently ship to ' + [...countries].join(', ') + '.' : '')
    });
  }
  return { address, errors };
}

/* The zone whose rules the address falls inside. A zone that names states is
   more specific than one that names none, so it is preferred. */
export function zoneForAddress(address, zones) {
  const inCountry = zones.filter(z => z.countries.includes(address.country));
  const withState = inCountry.filter(z => z.states.length && z.states.includes(address.state));
  if (withState.length) return withState[0];
  const anyState = inCountry.filter(z => !z.states.length);
  return anyState[0] || null;
}

export function shippingCharge(zone, subtotal) {
  if (!zone) return null;
  if (zone.freeOver !== null && subtotal >= zone.freeOver) {
    return { amount: 0, currency: zone.currency, zoneId: zone.id, label: zone.label, free: true };
  }
  return { amount: zone.amount, currency: zone.currency, zoneId: zone.id, label: zone.label, free: false };
}

/* --------------------------------------------------------------- entry */

export function validateFulfillment(raw, { settings, subtotal }) {
  const type = raw?.type === 'pickup' ? 'pickup' : raw?.type === 'shipping' ? 'shipping' : null;
  if (!type) {
    return { ok: false, errors: [{ field: 'fulfillment.type', message: 'Choose store pickup or shipping.' }] };
  }

  if (type === 'pickup' && !settings.pickup.enabled) {
    return {
      ok: false,
      errors: [{
        field: 'fulfillment.type',
        message: 'Store pickup is not switched on yet. ' +
          (settings.pickup.configured ? '' : 'The shop address has not been configured.')
      }]
    };
  }
  if (type === 'shipping' && !settings.shipping.enabled) {
    return {
      ok: false,
      errors: [{
        field: 'fulfillment.type',
        message: 'Shipping is not switched on yet. ' +
          (settings.shipping.configured ? '' : 'No shipping rates have been configured.')
      }]
    };
  }

  const { contact, errors: contactErrors } = validateContact(raw?.contact);
  const errors = [...contactErrors];

  if (type === 'pickup') {
    if (errors.length) return { ok: false, errors };
    return {
      ok: true,
      fulfillment: {
        type: 'pickup',
        contact,
        address: null,
        zoneId: null,
        shipping: null,
        /* Repeated verbatim onto the order so whoever picks it off the Square
           dashboard sees the same policy the customer agreed to. */
        policy: settings.pickup.policy,
        pickupAddress: settings.pickup.address
      }
    };
  }

  const { address, errors: addressErrors } = validateAddress(raw?.address, settings.shipping.zones);
  errors.push(...addressErrors);
  if (errors.length) return { ok: false, errors };

  const zone = zoneForAddress(address, settings.shipping.zones);
  if (!zone) {
    return {
      ok: false,
      errors: [{ field: 'address.state', message: 'We do not have a shipping rate for that address yet.' }]
    };
  }
  const charge = shippingCharge(zone, subtotal);

  return {
    ok: true,
    fulfillment: {
      type: 'shipping',
      contact,
      address,
      zoneId: zone.id,
      shipping: charge,
      policy: null,
      pickupAddress: null
    }
  };
}

/* What Square wants on the order. Kept here so the shapes live next to the
   validation that produced them.

   Square's recipient takes one display name, so the two fields are joined. */
export function squareRecipient(fulfillment) {
  const { contact, address } = fulfillment;
  const recipient = {
    display_name: (contact.firstName + ' ' + contact.lastName).trim(),
    email_address: contact.email,
    phone_number: contact.phone
  };
  if (address) {
    recipient.address = {
      address_line_1: address.line1,
      ...(address.line2 ? { address_line_2: address.line2 } : {}),
      locality: address.city,
      administrative_district_level_1: address.state,
      postal_code: address.postalCode,
      country: address.country
    };
  }
  return recipient;
}

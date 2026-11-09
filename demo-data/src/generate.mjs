// Builds a made-up venue's worth of IndieTix data: about 18 months of
// showtimes, orders, tickets, customers, text opt-ins and marketing posts,
// sized like a busy single-venue cinema with a live room. Every person is
// invented: emails use the reserved example.com/.org/.net domains, phone
// numbers are in the 555-0100..0199 range set aside for fiction, and IP
// addresses come from the documentation ranges. Nothing here ever reaches
// a real inbox or phone.
//
// Deterministic for a given seed and "today", so a reset rebuilds the same
// venue shifted to the current date (upcoming shows always look upcoming).

import crypto from 'crypto';
import {
  FIRST_NAMES, LAST_NAMES, NEW_RELEASES, REPERTORY, LIVE_ACTS, MOVIE_DISTRIBUTORS,
  REPERTORY_DISTRIBUTOR, EVENT_DISTRIBUTOR, REFUND_REASONS, USER_AGENTS
} from './names.mjs';

// Where load-sandbox.sh puts the demo's own logo in the static site (the
// same folder Client Settings' logo upload uses).
export const demoLogoPath = (clientId) => `venue-logos/${clientId}/demo-logo.png`;

export const DEMO_VENUE = {
  name: 'The Marquee',
  legalName: 'The Marquee Theater (demo venue)',
  city: 'Riverton, KS',
  theaterId: '90001',
  locationId: 'LDEMOMARQUEE01',
  rooms: { main: 'Main Auditorium', studio: 'Studio Theater', lounge: 'The Lounge' }
};

const DAY = 86400000;
const DAYS_AHEAD = 21;
const UTC_OFFSET_HOURS = 6; // Chicago wall-clock to UTC, close enough for demo data
// Area codes for the fictional 555-01xx numbers: nearby ones first, then the rest, 100 numbers each.
const AREA_CODES = [
  '785', '816', '913', '316', '620', '402',
  '201', '202', '203', '205', '206', '207', '208', '209', '210', '212', '213', '214', '215', '216', '217', '218', '219', '224', '225', '228',
  '229', '231', '234', '239', '240', '248', '251', '252', '253', '254', '256', '260', '262', '267', '269', '270', '276', '281', '301', '302',
  '303', '304', '305', '307', '308', '309', '310', '312', '313', '314', '315', '317', '318', '319', '320', '321', '323', '330', '334', '336',
  '337', '339', '347', '351', '352', '360', '361', '385', '386', '401', '404', '405', '406', '407', '408', '409', '410', '412', '413', '414',
  '415', '417', '419', '423', '425', '430', '432', '434', '435', '440', '443', '469', '478', '479', '480', '484', '501', '502', '503', '504',
  '505', '507', '508', '509', '510', '512', '513', '515', '516', '517', '518', '520', '530', '540', '541', '559', '561', '562', '563', '567',
  '570', '571', '573', '574', '580', '585', '586', '601', '602', '603', '605', '606', '607', '608', '609', '610', '612', '614', '615', '616',
  '617', '618', '619', '623', '626', '630', '631', '636', '641', '646', '650', '651', '660', '661', '662', '678', '682', '701', '702', '703',
  '704', '706', '707', '708', '712', '713', '714', '715', '716', '717', '718', '719', '720', '724', '727', '731', '732', '734', '740', '754',
  '757', '760', '763', '765', '770', '772', '773', '774', '775', '781', '786', '801', '802', '803', '804', '805', '806', '808', '810', '812',
  '813', '814', '815', '817', '818', '828', '830', '831', '832', '843', '845', '847', '848', '850', '856', '857', '858', '859', '860', '862',
  '863', '864', '865', '870', '901', '903', '904', '906', '907', '908', '909', '910', '912', '914', '915', '916', '917', '918', '919', '920',
  '925', '928', '931', '936', '937', '940', '941', '947', '949', '951', '952', '954', '956', '970', '971', '972', '973', '978', '979', '980',
  '985', '989'
];
const EMAIL_DOMAINS = ['example.com', 'example.org', 'example.net'];
const DOC_IP_PREFIXES = ['192.0.2.', '198.51.100.', '203.0.113.'];
const STAFF = [
  { username: 'manager', first: 'Robin', last: 'Calloway', permissions: { view: true, edit: true, checkIn: true, marketing: true, admin: false } },
  { username: 'boxoffice', first: 'Dana', last: 'Whitaker', permissions: { view: true, edit: false, checkIn: true, marketing: false, admin: false } },
  { username: 'door', first: 'Kit', last: 'Larkin', permissions: { view: false, edit: false, checkIn: true, marketing: false, admin: false } }
];
// Guest logins for people trying the demo: they can look at everything and
// scan tickets, but can't edit settings, staff, marketing or Insights.
const GUESTS = [
  { username: 'guest', first: 'Demo', last: 'Guest', permissions: { view: true, edit: false, checkIn: true, marketing: false, admin: false } },
  { username: 'guest-door', first: 'Demo', last: 'Door', permissions: { view: false, edit: false, checkIn: true, marketing: false, admin: false } }
];

// ---- random helpers (seeded) ----

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRandom(seed) {
  const r = mulberry32(seed);
  const int = (min, max) => min + Math.floor(r() * (max - min + 1));
  const pick = (list) => list[Math.floor(r() * list.length)];
  const chance = (p) => r() < p;
  const weighted = (pairs) => {
    const total = pairs.reduce((s, [, w]) => s + w, 0);
    let x = r() * total;
    for (const [value, w] of pairs) { if ((x -= w) < 0) return value; }
    return pairs[pairs.length - 1][0];
  };
  const chars = (n, alphabet) => Array.from({ length: n }, () => alphabet[Math.floor(r() * alphabet.length)]).join('');
  const SQUARE_ID = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const BASE64URL = BASE62 + '-_';
  return {
    r, int, pick, chance, weighted,
    squareId: () => chars(24, SQUARE_ID),
    orderId: () => chars(29, BASE62),
    token: () => chars(22, BASE64URL),
    uuid: () => [8, 4, 4, 4, 12].map(n => chars(n, '0123456789abcdef')).join('-')
  };
}

// ---- time helpers: wall-clock times are kept as UTC-field Dates ----

const pad = (n) => String(n).padStart(2, '0');
const sqlTime = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
const toUtc = (local) => new Date(local.getTime() + UTC_OFFSET_HOURS * 3600000);
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function showtimeLabel(local, room) {
  const h = local.getUTCHours();
  const h12 = h % 12 || 12;
  return `${DOW[local.getUTCDay()]} ${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}-${local.getUTCFullYear()} ${h12}:${pad(local.getUTCMinutes())} ${h < 12 ? 'AM' : 'PM'} (${room})`;
}
const ascii = (s) => s.normalize('NFD').replace(/[^\x20-\x7E]/g, '');

// ---- the venue's calendar ----

// Each show gets a relative demand (weight); planSales turns those into
// ticket counts that hit the requested averages and totals.
function buildShowtimes(rand, today, { kind, months }) {
  const start = new Date(today.getTime() - Math.round(months * 30.44) * DAY);
  const end = new Date(today.getTime() + DAYS_AHEAD * DAY);
  const cinema = kind !== 'live', live = kind !== 'cinema';
  const shows = [];
  const items = new Map(); // ProductName -> { productId, variations, distributor, type, room }
  const item = (name, type, room, distributor, ticketTypes) => {
    if (!items.has(name)) {
      items.set(name, {
        name, type, room, distributor, productId: rand.squareId(),
        variations: ticketTypes.map(t => ({ ...t, id: rand.squareId() }))
      });
    }
    return items.get(name);
  };

  let mainIndex = 0, mainTitle = null, mainUntil = 0, mainPopularity = 1;
  let repIndex = 0, repTitle = null, repUntil = 0;
  for (let t = start.getTime(); t <= end.getTime(); t += DAY) {
    const day = new Date(t);
    const dow = day.getUTCDay();
    const weekend = dow === 5 || dow === 6;
    const at = (h, m) => new Date(t + h * 3600000 + m * 60000);

    if (cinema) {
      // Main Auditorium: a new release every week or two, Thursday to Sunday.
      if (dow === 4 && t >= mainUntil) {
        mainPopularity = rand.weighted([[0.6, 3], [1, 5], [1.6, 2], [2.6, 1]]);
        const year = day.getUTCFullYear();
        mainTitle = item(`${NEW_RELEASES[mainIndex++ % NEW_RELEASES.length]} (${year})`, 'Movie', DEMO_VENUE.rooms.main,
          rand.pick(MOVIE_DISTRIBUTORS), [{ name: 'Adult', price: 12.5 }, { name: 'Senior', price: 11 }, { name: 'Child', price: 10 }]);
        mainUntil = t + (mainPopularity > 1.5 ? 14 : 7) * DAY;
      }
      if (mainTitle && [4, 5, 6, 0].includes(dow)) {
        const times = dow === 6 ? [[16, 0], [19, 0]] : dow === 0 ? [[16, 0]] : [[19, 0]];
        for (const [h, m] of times) shows.push({ item: mainTitle, local: at(h, m), capacity: 220, weight: 1.4 * mainPopularity * (weekend ? 1.35 : 0.8), matinee: h < 17 });
      }
      // Studio Theater: a repertory classic each week, Friday to Sunday.
      if (dow === 5 && t >= repUntil) {
        repTitle = item(REPERTORY[repIndex++ % REPERTORY.length], 'Movie', DEMO_VENUE.rooms.studio,
          REPERTORY_DISTRIBUTOR, [{ name: 'Adult', price: 10 }, { name: 'Senior', price: 9 }]);
        repUntil = t + 7 * DAY;
      }
      if (repTitle && [5, 6, 0].includes(dow)) {
        shows.push({ item: repTitle, local: dow === 0 ? at(13, 0) : at(19, 30), capacity: 60, weight: 0.6 * (weekend ? 1.35 : 0.8), matinee: dow === 0 });
      }
    }

    if (live) {
      // The Lounge: live music Fridays, most Saturdays, and some Wednesdays
      // (and Thursdays too when the venue is live-only).
      const lounge = (h, m, p) => {
        if (!rand.chance(p)) return;
        const act = rand.pick(LIVE_ACTS);
        const price = rand.weighted([[0, 1], [10, 3], [12, 2], [15, 3], [20, 2], [25, 1]]);
        const types = [{ name: 'General Admission', price }];
        if (price >= 20 && rand.chance(0.4)) types.push({ name: 'VIP', price: price + 20 });
        const ev = item(act, 'Live', DEMO_VENUE.rooms.lounge, EVENT_DISTRIBUTOR, types);
        shows.push({ item: ev, local: at(h, m), capacity: 150, weight: (price === 0 ? 1.8 : 0.9) * (weekend ? 1.35 : 0.8), matinee: false });
      };
      if (dow === 5) lounge(21, 0, 1);
      if (dow === 6) lounge(20, 0, cinema ? 0.6 : 1);
      if (dow === 3) lounge(19, 0, 0.35);
      if (dow === 4 && !cinema) lounge(20, 0, 0.6);
    }
  }
  return shows.sort((a, b) => a.local - b.local);
}

// How many tickets each show sells. Upcoming shows have only presales so
// far. With a total, the counts are scaled to hit it exactly.
function planSales(rand, shows, now, { ticketsPerMovie, ticketsPerLive, tickets }) {
  const perType = { Movie: ticketsPerMovie, Live: ticketsPerLive };
  const meanWeight = {};
  for (const type of ['Movie', 'Live']) {
    const ws = shows.filter(s => s.item.type === type).map(s => s.weight);
    meanWeight[type] = ws.length ? ws.reduce((a, b) => a + b, 0) / ws.length : 1;
  }
  for (const show of shows) {
    const days = (toUtc(show.local) - now) / DAY;
    show.soldShare = days <= 0 ? 1 : days <= 3 ? 0.5 : days <= 10 ? 0.25 : 0.1;
    show.target = perType[show.item.type] * (show.weight / meanWeight[show.item.type]) * (0.55 + rand.r() * 0.9);
    if (rand.chance(0.02)) show.target *= 2.5; // the odd sell-out
  }
  // Averages are over shows that have happened; upcoming ones are partly sold.
  const past = shows.filter(s => s.soldShare === 1);
  for (const type of ['Movie', 'Live']) {
    const typed = past.filter(s => s.item.type === type);
    const mean = typed.reduce((a, s) => a + s.target, 0) / (typed.length || 1);
    for (const s of shows) if (s.item.type === type && mean) s.target *= perType[type] / mean;
  }
  const scale = tickets ? tickets / shows.reduce((a, s) => a + s.target * s.soldShare, 0) : 1;
  for (const show of shows) {
    show.sold = Math.round(show.target * scale * show.soldShare);
    if (show.soldShare === 1) show.sold = Math.max(1, show.sold);
  }
  if (tickets) {
    // Settle the rounding on shows that have happened.
    let diff = tickets - shows.reduce((a, s) => a + s.sold, 0);
    for (let guard = 0; diff !== 0 && guard < 10 * shows.length; guard++) {
      const s = past[Math.floor(rand.r() * past.length)];
      if (diff > 0) { s.sold++; diff--; } else if (s.sold > 1) { s.sold--; diff++; }
    }
  }
  for (const show of shows) show.capacity = Math.max(show.capacity, Math.ceil(show.sold / show.soldShare));
}

function buildPeople(rand, count) {
  const people = [];
  const phones = [];
  for (const area of AREA_CODES) for (let n = 100; n <= 199; n++) phones.push(`+1${area}55501${String(n).slice(1)}`);
  // Shuffle the nearby numbers (the first 600) and use them first.
  const nearby = phones.splice(0, 600);
  for (let i = nearby.length - 1; i > 0; i--) { const j = Math.floor(rand.r() * (i + 1)); [nearby[i], nearby[j]] = [nearby[j], nearby[i]]; }
  phones.reverse().push(...nearby);
  const used = new Set();
  for (let i = 0; i < count; i++) {
    const first = rand.pick(FIRST_NAMES);
    const last = rand.pick(LAST_NAMES);
    let local = ascii(`${first}.${last}`).toLowerCase(), email, k = 0;
    do { email = `${local}${k ? k : ''}@${rand.pick(EMAIL_DOMAINS)}`; k++; } while (used.has(email));
    used.add(email);
    const phone = phones.length && rand.chance(0.45) ? phones.pop() : null;
    // A few regulars buy most of the tickets.
    const weight = rand.weighted([[0.3, 70], [1, 22], [4, 6], [12, 2]]);
    people.push({ first, last, email, phone, weight });
  }
  return people;
}

// Hands out buyers so that every customer buys at least once and repeat
// buyers are mostly the regulars: a new customer comes in at the rate that
// uses them all up by the last order.
function buyerPicker(rand, people, namedOrders) {
  const fresh = [...people];
  for (let i = fresh.length - 1; i > 0; i--) { const j = Math.floor(rand.r() * (i + 1)); [fresh[i], fresh[j]] = [fresh[j], fresh[i]]; }
  const seen = [], cumulative = [];
  let sum = 0, handed = 0;
  return () => {
    const left = Math.max(1, namedOrders - handed++);
    if (fresh.length && (rand.r() < fresh.length / left || !seen.length)) {
      const p = fresh.pop();
      seen.push(p); sum += p.weight; cumulative.push(sum);
      return p;
    }
    const x = rand.r() * sum;
    let lo = 0, hi = cumulative.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cumulative[mid] > x) hi = mid; else lo = mid + 1; }
    return seen[lo];
  };
}

// Splits one show's tickets into orders averaging meanSize tickets each:
// the order count is rounded at random (so totals come out right), then the
// tickets beyond one per order are dealt out at random.
function splitIntoOrders(rand, sold, meanSize) {
  if (sold <= 0) return [];
  const exact = sold / meanSize;
  const count = Math.min(sold, Math.max(1, Math.floor(exact) + (rand.r() < exact % 1 ? 1 : 0)));
  const sizes = new Array(count).fill(1);
  for (let i = count; i < sold; i++) sizes[Math.floor(rand.r() * count)]++;
  return sizes;
}

export const DEFAULT_OPTIONS = { kind: 'both', months: 18, ticketsPerMovie: 10, ticketsPerLive: 14, ticketsPerOrder: 1.75, ordersPerCustomer: 1.9 };

/** Checks and fills in the size options; throws with a readable message. */
export function resolveOptions(input = {}) {
  const o = { ...DEFAULT_OPTIONS, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined && v !== null && v !== '')) };
  if (!['both', 'cinema', 'live'].includes(o.kind)) throw new Error(`kind must be cinema, live or both (got "${o.kind}")`);
  const positive = (name, max, integer) => {
    if (input[name] === undefined || input[name] === null || input[name] === '') return;
    const v = Number(input[name]);
    if (!Number.isFinite(v) || v <= 0 || v > max || (integer && !Number.isInteger(v))) throw new Error(`${name} must be a${integer ? ' whole' : ''} number above 0 and at most ${max}`);
    o[name] = v;
  };
  positive('months', 60, false);
  positive('tickets', 1000000, true);
  positive('customers', 100000, true);
  positive('ordersPerCustomer', 50, false);
  positive('ticketsPerMovie', 1000, false);
  positive('ticketsPerLive', 1000, false);
  return o;
}

const money = (cents) => ({ amount: cents, currency: 'USD' });

/**
 * @param {object} options
 * @param {number} [options.seed]
 * @param {Date} [options.now] - generation time; shows within 21 days after it are "upcoming"
 * @param {string} options.clientId - the demo venue's client ID (its database name)
 * @param {string} [options.siteUrl] - the environment's static site, for opt-in links
 * @param {string} options.staffPasswordHash - bcrypt hash for the staff logins
 * @param {string} options.guestPasswordHash - bcrypt hash for the guest logins
 * @param {'both'|'cinema'|'live'} [options.kind] - what the venue shows (default both)
 * @param {number} [options.months] - months of history (default 18)
 * @param {number} [options.tickets] - total tickets sold; scales the per-show numbers to hit it exactly
 * @param {number} [options.ticketsPerMovie] - average tickets per cinema showtime (default 10)
 * @param {number} [options.ticketsPerLive] - average tickets per live event (default 14)
 * @param {number} [options.customers] - how many different people buy tickets
 * @param {number} [options.ordersPerCustomer] - average orders per customer (default 1.9)
 */
export function generateDemo({ seed = 20260401, now = new Date(), clientId, siteUrl = '', staffPasswordHash, guestPasswordHash, ...sizeOptions }) {
  if (!clientId) throw new Error('clientId is required');
  if (!staffPasswordHash || !guestPasswordHash) throw new Error('staff and guest password hashes are required');
  const options = resolveOptions(sizeOptions);
  const rand = makeRandom(seed);
  // "now" as Chicago wall-clock, and the start of that day.
  const nowLocal = new Date(now.getTime() - UTC_OFFSET_HOURS * 3600000);
  const today = new Date(Date.UTC(nowLocal.getUTCFullYear(), nowLocal.getUTCMonth(), nowLocal.getUTCDate()));
  const shows = buildShowtimes(rand, today, options);
  planSales(rand, shows, now, options);

  // Orders and customers: from customers x orders per customer when given,
  // otherwise from the usual 1.75 tickets an order.
  const totalTickets = shows.reduce((a, s) => a + s.sold, 0);
  const anonymousShare = 0.06; // walk-up cash sales with no name
  let namedOrders, customerCount;
  if (options.customers) {
    customerCount = options.customers;
    namedOrders = Math.max(customerCount, Math.round(customerCount * options.ordersPerCustomer));
  } else {
    namedOrders = Math.round(totalTickets / options.ticketsPerOrder * (1 - anonymousShare));
    customerCount = Math.max(1, Math.round(namedOrders / options.ordersPerCustomer));
  }
  if (namedOrders > totalTickets) throw new Error(`${namedOrders} orders need at least as many tickets, but only ${totalTickets} are sold; raise the tickets or lower the customers / orders per customer`);
  const meanOrderSize = totalTickets / (namedOrders / (1 - anonymousShare));

  // Plan every order first (when it was bought, at the door or online, by a
  // named buyer or not), so buyers can be handed out to exactly the right count.
  const plans = [];
  for (const show of shows) {
    const upcoming = toUtc(show.local) > now;
    for (const size of splitIntoOrders(rand, show.sold, meanOrderSize)) {
      let lead, purchaseLocal;
      if (upcoming) {
        // Presales: bought some time in the last ten days.
        lead = 99;
        purchaseLocal = new Date(nowLocal.getTime() - rand.int(30, 10 * 24 * 60) * 60000);
      } else {
        lead = rand.weighted([[0, 40], [1, 20], [2, 10], [3, 5], [rand.int(4, 14), 25]]);
        purchaseLocal = new Date(show.local.getTime() - lead * DAY - rand.int(10, lead ? 600 : 300) * 60000);
        if (toUtc(purchaseLocal) > now) purchaseLocal = new Date(nowLocal.getTime() - 60000);
      }
      const atDoor = lead === 0 && rand.chance(0.35);
      plans.push({ show, size, createdUtc: toUtc(purchaseLocal), atDoor, anonymous: atDoor && rand.chance(anonymousShare / 0.14) });
    }
  }
  const named = plans.filter(p => !p.anonymous).length;
  const people = buildPeople(rand, Math.min(customerCount, named));
  const choose = buyerPicker(rand, people, named);

  const orders = [], tickets = [], links = [], customers = [], consents = [], smsLog = [];
  const customerByPhone = new Map();
  const qrCodes = new Set();
  const staffNames = STAFF.filter(s => s.permissions.view).map(s => `${s.first} ${s.last}`);
  const sortedShows = shows;

  for (const { show, size, createdUtc, atDoor, anonymous } of plans) {
    const showUtc = toUtc(show.local);
    {
      const buyer = anonymous ? null : choose();
      let customer = null;
      if (buyer?.phone) {
        customer = customerByPhone.get(buyer.phone);
        if (!customer) {
          customer = { ID: customers.length + 1, PhoneNumber: buyer.phone, Email: buyer.email, FirstName: buyer.first, LastName: buyer.last, CreatedDate: sqlTime(createdUtc), UpdatedDate: sqlTime(createdUtc) };
          customers.push(customer);
          customerByPhone.set(buyer.phone, customer);
        }
      }

      const orderId = rand.orderId();
      const orderRow = {
        ID: orders.length + 1, OrderID: orderId, CreatedDate: sqlTime(createdUtc), LastEditedDate: sqlTime(createdUtc),
        PhoneNumber: buyer?.phone || null, LastName: buyer?.last || null, FirstName: buyer?.first || null, EmailAddress: buyer?.email || null,
        Status: 'Valid', OptInToken: buyer?.email ? rand.token() : null, CustomerID: customer?.ID || null, OptInClaimedByPhone: null
      };
      const lineItems = [];
      const orderTickets = [];
      let totalCents = 0;
      const variations = show.item.variations;
      for (let i = 0; i < size; i++) {
        let v = variations[0];
        if (variations.length > 1) {
          v = show.item.type === 'Live'
            ? rand.weighted([[variations[0], 85], [variations[1], 15]])
            : rand.weighted(variations.map((x, idx) => [x, idx === 0 ? 66 : idx === 1 ? 18 : (show.matinee ? 30 : 10)]));
        }
        const cents = Math.round(v.price * 100);
        totalCents += cents;
        const lineUid = rand.uuid();
        const details = showtimeLabel(show.local, show.item.room);
        const lineItem = {
          uid: lineUid, name: show.item.name, quantity: '1', item_type: 'ITEM',
          modifiers: [{ uid: rand.uuid(), name: details, quantity: '1', base_price_money: money(0), total_price_money: money(0) }],
          location_id: DEMO_VENUE.locationId, variation_name: v.name, catalog_object_id: v.id,
          base_price_money: money(cents), gross_sales_money: money(cents), total_money: money(cents),
          total_tax_money: money(0), total_discount_money: money(0), variation_total_price_money: money(cents)
        };
        lineItems.push(lineItem);
        let qr;
        do { qr = `${show.item.name}_${v.name}_${orderId}_${lineUid.slice(0, 8)}_${i}_${createdUtc.getTime()}`; } while (qrCodes.has(qr));
        qrCodes.add(qr);
        const past = showUtc < now;
        const checkedIn = past && rand.chance(atDoor ? 0.9 : 0.62);
        const ticket = {
          ID: tickets.length + 1, QRCode: qr, CheckedIn: checkedIn, CreatedDate: sqlTime(createdUtc),
          ExpirationDate: sqlTime(new Date(createdUtc.getTime() + 90 * DAY)),
          LastEditedDate: sqlTime(checkedIn ? new Date(showUtc.getTime() - rand.int(0, 25) * 60000) : createdUtc),
          ProductMetadata: lineItem, ProductDate: sqlTime(show.local), ProductName: show.item.name,
          ProductLocation: DEMO_VENUE.locationId, ProductType: show.item.type, ProductDetails: details,
          ProductPrice: v.price, ProductID: show.item.productId, EmailAddress: orderRow.EmailAddress,
          FirstName: orderRow.FirstName, LastName: orderRow.LastName, PhoneNumber: orderRow.PhoneNumber,
          Distributor: show.item.distributor, ProductVenue: show.item.room, ProductSeatCode: v.name,
          Status: 'valid', CustomerID: orderRow.CustomerID
        };
        tickets.push(ticket);
        orderTickets.push(ticket);
        links.push({ ID: links.length + 1, QRCodeProductID: ticket.ID, OrderID: orderRow.ID, CreatedDate: ticket.CreatedDate, UpdatedDate: ticket.CreatedDate });
      }

      const source = atDoor ? 'Point of Sale' : 'Square Online';
      const meta = {
        order: {
          id: orderId, state: 'COMPLETED', source: { name: source }, location_id: DEMO_VENUE.locationId,
          created_at: createdUtc.toISOString(), updated_at: createdUtc.toISOString(), closed_at: createdUtc.toISOString(),
          line_items: lineItems, total_money: money(totalCents), total_tax_money: money(0), total_tip_money: money(0),
          total_discount_money: money(0), total_service_charge_money: money(0),
          tenders: [{
            id: orderId, type: atDoor && rand.chance(0.4) ? 'CASH' : 'CARD', payment_id: orderId, transaction_id: orderId, amount_money: money(totalCents),
            location_id: DEMO_VENUE.locationId, created_at: createdUtc.toISOString(),
            card_details: { card: { card_brand: rand.pick(['VISA', 'MASTERCARD', 'AMERICAN_EXPRESS', 'DISCOVER']), last_4: String(rand.int(1000, 9999)) }, status: 'CAPTURED', entry_method: atDoor ? 'CONTACTLESS' : 'KEYED' }
          }]
        }
      };

      // A few orders are refunded before the show by staff through IndieTix.
      if (!atDoor && rand.chance(0.022)) {
        const refundedAt = new Date(Math.min(showUtc.getTime() - 3600000, createdUtc.getTime() + rand.int(1, 48) * 3600000));
        if (refundedAt > createdUtc && refundedAt < now) {
          orderRow.Status = 'Refunded';
          meta.refund = {
            amount: totalCents, partial: false, currency: 'USD', refundId: `${orderId}_${rand.orderId()}`, orderTotal: totalCents,
            refundedAt: refundedAt.toISOString(), refundedBy: rand.pick(staffNames), refundReason: rand.pick(REFUND_REASONS),
            refundStatus: 'COMPLETED', refundedTickets: orderTickets.map(t => t.QRCode),
            refundedByAccount: { clientId, userType: 'user' }, ticketsInvalidated: orderTickets.length
          };
          for (const t of orderTickets) { t.Status = 'refunded'; t.CheckedIn = false; t.LastEditedDate = sqlTime(refundedAt); }
          orderRow.LastEditedDate = sqlTime(refundedAt);
        }
      } else if (!atDoor && rand.chance(0.001)) {
        orderRow.Status = 'Cancelled';
        meta.cancel = { cancelledAt: createdUtc.toISOString(), cancelledBy: rand.pick(staffNames) };
        for (const t of orderTickets) { t.Status = 'cancelled'; t.CheckedIn = false; }
      }
      orderRow.OrderMetaData = meta;
      orders.push(orderRow);
    }
  }

  // Text opt-ins: some customers opt in from an order's confirmation email.
  const consentText = `By checking this box, I agree to receive an automated ticket delivery text from ${DEMO_VENUE.name}. Msg & data rates may apply. Reply STOP to unsubscribe, HELP for help.`;
  const ordersByCustomer = new Map();
  for (const o of orders) if (o.CustomerID && o.OptInToken) {
    if (!ordersByCustomer.has(o.CustomerID)) ordersByCustomer.set(o.CustomerID, []);
    ordersByCustomer.get(o.CustomerID).push(o);
  }
  const smsSince = new Date(now.getTime() - 30 * DAY);
  for (const customer of customers) {
    const theirOrders = ordersByCustomer.get(customer.ID);
    // Regulars are likelier to opt in.
    if (!theirOrders || !rand.chance(Math.min(0.9, 0.1 + 0.2 * theirOrders.length))) continue;
    const first = theirOrders[0];
    first.OptInClaimedByPhone = customer.PhoneNumber;
    const consentAt = new Date(new Date(first.CreatedDate.replace(' ', 'T') + 'Z').getTime() + rand.int(2, 90) * 60000);
    const revoked = rand.chance(0.08);
    const consent = {
      ID: consents.length + 1, CustomerID: customer.ID, PhoneNumber: customer.PhoneNumber,
      Status: revoked ? 'revoked' : 'active', OptInMethod: 'web_initial', ConsentText: consentText,
      ConsentURL: siteUrl ? `${siteUrl}/opt-in/${first.OptInToken}?client=${clientId}` : null,
      IPAddress: rand.pick(DOC_IP_PREFIXES) + rand.int(1, 254), UserAgent: rand.pick(USER_AGENTS), CampaignID: null,
      PreviousConsentID: null, ConsentTimestamp: sqlTime(consentAt),
      RevokedAt: revoked ? sqlTime(new Date(consentAt.getTime() + rand.int(5, 120) * DAY)) : null, CreatedDate: sqlTime(consentAt)
    };
    if (revoked && new Date(consent.RevokedAt.replace(' ', 'T') + 'Z') > now) { consent.Status = 'active'; consent.RevokedAt = null; }
    consents.push(consent);
    // Texts sent in the last 30 days (the log keeps about that long).
    if (consent.Status === 'active') {
      for (const o of theirOrders) {
        const sentAt = new Date(o.CreatedDate.replace(' ', 'T') + 'Z');
        if (sentAt < smsSince || sentAt < consentAt || o.Status !== 'Valid') continue;
        // One text per ticket, like getSquareOrders sends.
        for (const line of o.OrderMetaData.order.line_items) {
          smsLog.push({ ID: smsLog.length + 1, PhoneNumber: customer.PhoneNumber, MessageID: rand.uuid(), BodyPreview: `Your ticket for ${line.name} at ${DEMO_VENUE.name}: ${siteUrl || 'https://example.com'}/t/…`.slice(0, 160), SentAt: sqlTime(new Date(sentAt.getTime() + 20000)) });
        }
      }
    }
  }

  // Email list sign-ups, from ticket buyers.
  const emailContacts = [];
  const seenEmails = new Set();
  for (const o of orders) {
    if (!o.EmailAddress || seenEmails.has(o.EmailAddress) || !rand.chance(0.12)) continue;
    seenEmails.add(o.EmailAddress);
    emailContacts.push({ ID: emailContacts.length + 1, Email: o.EmailAddress, Status: rand.chance(0.06) ? 'unsubscribed' : 'active', UnsubscribeToken: rand.token(), CreatedDate: o.CreatedDate });
  }

  // Marketing posts for the coming weeks' shows (and the last few weeks', already sent).
  const posts = [];
  const postSlots = new Set();
  for (const show of sortedShows) {
    const daysOut = (show.local - today) / DAY;
    if (daysOut < -21 || daysOut > DAYS_AHEAD) continue;
    if (show.item.type === 'Movie' && show.item.room === DEMO_VENUE.rooms.studio && !rand.chance(0.5)) continue;
    const when = new Date(show.local.getTime() - 3 * DAY);
    when.setUTCHours(10, 0, 0, 0);
    for (const channel of ['facebook', 'instagram']) {
      const slot = `${show.item.productId}|${channel}|${when.getTime()}`;
      if (postSlots.has(slot)) continue;
      postSlots.add(slot);
      const sent = toUtc(when) < now;
      const price = show.item.variations.map(v => v.price).filter(p => p > 0);
      const caption = `${show.item.name} at ${DEMO_VENUE.name}, ${showtimeLabel(show.local, show.item.room)}.${price.length ? ` Tickets from $${Math.min(...price).toFixed(2)}.` : ' Free admission.'}`;
      posts.push({
        ID: posts.length + 1, SquareItemID: show.item.productId, Channel: channel, PostType: 'campaign', ScheduledFor: sqlTime(when),
        Status: sent ? 'sent' : rand.weighted([['approved', 2], ['draft', 1]]), FailureReason: null,
        PlatformPostID: sent ? String(rand.int(100000000, 999999999)) : null, PostContent: { caption, imageUrl: null },
        CreatedDate: sqlTime(toUtc(new Date(when.getTime() - 7 * DAY))), UpdatedDate: sqlTime(toUtc(when))
      });
    }
  }

  // One staff comp pass, used a few times.
  const skeletonKeys = [{ id: 1, qrCode: `MARQUEE-STAFF-COMP-${rand.token().slice(0, 10)}`, description: 'Staff comp pass', eventName: null, keyType: 'staff', isActive: true, maxUsesPerDay: 4, maxTotalUses: null, expiresAt: null, createdAt: sqlTime(toUtc(new Date(today.getTime() - 200 * DAY))), lastUsedAt: null, totalUses: 0 }];
  const skeletonUsage = [];
  for (const show of sortedShows.filter(s => toUtc(s.local) < now).slice(-60)) {
    if (!rand.chance(0.18)) continue;
    const usedAt = sqlTime(new Date(toUtc(show.local).getTime() - 15 * 60000));
    skeletonUsage.push({ id: skeletonUsage.length + 1, skeletonKeyId: 1, usedAt, eventName: show.item.name, notes: null, ipAddress: rand.pick(DOC_IP_PREFIXES) + rand.int(1, 254) });
    skeletonKeys[0].lastUsedAt = usedAt;
  }
  skeletonKeys[0].totalUses = skeletonUsage.length;

  const users = [...STAFF.map(u => ({ ...u, hash: staffPasswordHash })), ...GUESTS.map(u => ({ ...u, hash: guestPasswordHash }))]
    .map((u, i) => ({ ID: i + 1, Username: u.username, Password: u.hash, Email: `${u.username}@example.com`, FirstName: u.first, LastName: u.last, Permissions: u.permissions, DataFilter: { datafilters: [] } }));

  // No Square connection: a blank token makes the nightly Square jobs skip
  // this venue, and Square-backed pages say Square isn't connected.
  const settings = {
    SQUARE_ACCESS_TOKEN: '', SQUARE_SIGNATURE_KEY: '',
    WEB_HEADER_COMPANY: DEMO_VENUE.name, THEATER_NAME: DEMO_VENUE.name, SEND_SMS: 'false', USE_FTP: 'false',
    LOGO_FILE: demoLogoPath(clientId), // assets/marquee-logo.png, uploaded by load-sandbox.sh
    SALES_TAX_RATE: '8.5', SCREEN_NUMBERS: { studio: '2' },
    EVENT_LOCATIONS: Object.values(DEMO_VENUE.rooms), SQUARE_LOCATION_ID: DEMO_VENUE.locationId,
    MOVIE_DISTRIBUTOR: MOVIE_DISTRIBUTORS[0], EVENT_DISTRIBUTOR, MARKETING_ENGINE_ENABLED: 'false',
    MOVIE_TICKET_TYPES: JSON.stringify([{ name: 'Adult', price: '12.50' }, { name: 'Senior', price: '11.00' }, { name: 'Child', price: '10.00' }]),
    EVENT_TICKET_TYPES: JSON.stringify([{ name: 'General Admission', price: '15.00' }, { name: 'VIP', price: '35.00' }]),
    USERS_NAMES: STAFF.filter(u => u.permissions.view).map(u => `${u.first} ${u.last}`),
    EVENT_DESCRIPTORS: ['Closed Caption', '21+', 'All Ages', 'Q&A After'],
    LEGAL_NAME: DEMO_VENUE.legalName, LEGAL_SHORT_NAME: DEMO_VENUE.name, LEGAL_ADDRESS: `100 Example Street, ${DEMO_VENUE.city} 00000`,
    LEGAL_PHONE: '(785) 555-0100', LEGAL_EMAIL: 'hello@example.com', LEGAL_STATE: 'Kansas', LEGAL_COURT_COUNTY: 'Example County'
  };

  return {
    venue: DEMO_VENUE, settings,
    tables: {
      Customer: customers, Order: orders, QRCodeProduct: tickets, QRCodeProductToOrder: links,
      SmsConsent: consents, SmsOutboundLog: smsLog, MarketingPost: posts, MarketingEmailContact: emailContacts,
      SkeletonKey: skeletonKeys, SkeletonKeyUsage: skeletonUsage, Users: users
    },
    logins: { staff: STAFF.map(u => u.username), guests: GUESTS.map(u => u.username) },
    summary: {
      kind: options.kind, months: options.months, tickets: tickets.length, orders: orders.length,
      customers: new Set(orders.filter(o => o.EmailAddress).map(o => o.EmailAddress)).size,
      ordersPerCustomer: Number((orders.filter(o => o.EmailAddress).length / Math.max(1, new Set(orders.filter(o => o.EmailAddress).map(o => o.EmailAddress)).size)).toFixed(2)),
      showtimes: { movie: shows.filter(x => x.item.type === 'Movie').length, live: shows.filter(x => x.item.type === 'Live').length }
    }
  };
}

// ---- SQL ----

const JSON_COLUMNS = new Set(['OrderMetaData', 'ProductMetadata', 'PostContent']);   // jsonb
const JSON_TEXT_COLUMNS = new Set(['Permissions', 'DataFilter']);                    // json
function literal(column, value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  const quoted = `'${text.replace(/'/g, "''")}'`;
  if (JSON_COLUMNS.has(column)) return `${quoted}::jsonb`;
  if (JSON_TEXT_COLUMNS.has(column)) return `${quoted}::json`;
  return quoted;
}

// Every venue table the demo fills (Client keeps its row, with settings merged in).
export const RESET_TABLES = ['QRCodeProductToOrder', 'QRCodeProduct', 'Order', 'Customer', 'SmsConsent', 'SmsOutboundLog',
  'MarketingSchedule', 'MarketingPost', 'MarketingEmailContact', 'SkeletonKeyUsage', 'SkeletonKey', 'Users',
  'ApiIdempotency', 'ApiKey', 'PrivacyRequest'];
const ID_COLUMN = { SkeletonKey: 'id', SkeletonKeyUsage: 'id' };

/** Yields SQL statements (strings) that reset the venue and load the demo, in order; each stays under maxBytes. */
export function* sqlChunks(demo, { maxBytes = 1500000 } = {}) {
  yield [
    // Only the tables this venue has: one onboarded by older code may lack a newer one.
    `DO $$ DECLARE present text; BEGIN
       SELECT string_agg(format('%I', t), ', ') INTO present
         FROM unnest(ARRAY[${RESET_TABLES.map(t => `'${t}'`).join(', ')}]) AS t WHERE to_regclass(format('public.%I', t)) IS NOT NULL;
       EXECUTE 'TRUNCATE ' || present || ' RESTART IDENTITY';
     END $$`,
    `UPDATE "Client" SET "configuration" = ("configuration"::jsonb || ${literal('OrderMetaData', demo.settings)})::json`
  ].join(';\n') + ';';
  for (const [table, rows] of Object.entries(demo.tables)) {
    if (!rows.length) continue;
    const columns = Object.keys(rows[0]);
    const head = `INSERT INTO "${table}" (${columns.map(c => `"${c}"`).join(', ')}) VALUES\n`;
    let values = [];
    let size = head.length;
    for (const row of rows) {
      const tuple = `(${columns.map(c => literal(c, row[c])).join(', ')})`;
      if (size + tuple.length > maxBytes && values.length) {
        yield head + values.join(',\n') + ';';
        values = [];
        size = head.length;
      }
      values.push(tuple);
      size += tuple.length + 2;
    }
    if (values.length) yield head + values.join(',\n') + ';';
  }
  yield Object.keys(demo.tables).map(table => {
    const id = ID_COLUMN[table] || 'ID';
    return `SELECT setval(pg_get_serial_sequence('public."${table}"', '${id}'), COALESCE((SELECT MAX("${id}") FROM "${table}"), 0) + 1, false)`;
  }).join(';\n') + ';';
}

/** All of sqlChunks as an array (fine at normal sizes; large venues should stream sqlChunks). */
export const toSql = (demo, options) => [...sqlChunks(demo, options)];

export const randomPassword = () => crypto.randomBytes(12).toString('base64url');

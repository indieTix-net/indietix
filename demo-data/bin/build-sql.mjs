// Writes the demo venue's SQL to numbered files (for load-sandbox.sh), or
// loads it straight into a database you can reach, such as a local Postgres
// for performance tests:
//   node bin/build-sql.mjs --client <clientId> --out <dir> [--site <url>] [size options]
//   node bin/build-sql.mjs --client <clientId> --database-url postgres://... [size options]
// The database must already have the venue schema and its Client row
// (onboarding creates both); loading replaces the venue's data.
// Size options (all optional; see README):
//   --kind cinema|live|both   --months <n>
//   --tickets <n>             --tickets-per-movie <n>   --tickets-per-live <n>
//   --customers <n>           --orders-per-customer <n> --seed <n>
// Passwords come from DEMO_STAFF_PASSWORD / DEMO_GUEST_PASSWORD, or are made
// up and printed once.
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { generateDemo, sqlChunks, randomPassword } from '../src/generate.mjs';

const FLAGS = {
  client: 'client', out: 'out', 'database-url': 'databaseUrl', site: 'site', seed: 'seed', kind: 'kind', months: 'months',
  tickets: 'tickets', 'tickets-per-movie': 'ticketsPerMovie', 'tickets-per-live': 'ticketsPerLive',
  customers: 'customers', 'orders-per-customer': 'ordersPerCustomer'
};
const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const flag = argv[i].replace(/^--/, '');
  if (!argv[i].startsWith('--') || !FLAGS[flag] || argv[i + 1] === undefined) {
    console.error(`Unknown or incomplete option: ${argv[i]}\nOptions: ${Object.keys(FLAGS).map(f => `--${f}`).join(' ')}`);
    process.exit(1);
  }
  args[FLAGS[flag]] = argv[++i];
}
if (!args.client || Boolean(args.out) === Boolean(args.databaseUrl)) {
  console.error('Usage: node bin/build-sql.mjs --client <clientId> (--out <dir> | --database-url <url>) [--site <url>] [size options]');
  process.exit(1);
}
const numeric = ['seed', 'months', 'tickets', 'ticketsPerMovie', 'ticketsPerLive', 'customers', 'ordersPerCustomer'];
for (const key of numeric) if (args[key] !== undefined) args[key] = Number(args[key]);

const staffPassword = process.env.DEMO_STAFF_PASSWORD || randomPassword();
const guestPassword = process.env.DEMO_GUEST_PASSWORD || randomPassword();
let demo;
const generateStarted = Date.now();
try {
  const { client, out, databaseUrl, site, ...size } = args;
  demo = generateDemo({
    ...size, clientId: client, siteUrl: site || '',
    staffPasswordHash: bcrypt.hashSync(staffPassword, 10), guestPasswordHash: bcrypt.hashSync(guestPassword, 10)
  });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const s = demo.summary;
console.log(`${s.kind === 'both' ? 'Cinema + live' : s.kind === 'cinema' ? 'Cinema only' : 'Live only'}, ${s.months} months: ${s.showtimes.movie} cinema showtimes, ${s.showtimes.live} live events`);
console.log(`${s.tickets} tickets, ${s.orders} orders, ${s.customers} customers (${s.ordersPerCustomer} orders each on average)`);
for (const [table, rows] of Object.entries(demo.tables)) console.log(`  ${table.padEnd(22)} ${rows.length}`);
console.log(`Generated in ${((Date.now() - generateStarted) / 1000).toFixed(1)} s`);

const started = Date.now();
let chunks = 0;
if (args.out) {
  fs.mkdirSync(args.out, { recursive: true });
  for (const sql of sqlChunks(demo)) fs.writeFileSync(path.join(args.out, `${String(chunks++).padStart(4, '0')}.sql`), sql);
  console.log(`${chunks} SQL files in ${args.out}`);
} else {
  const db = new pg.Client({ connectionString: args.databaseUrl });
  await db.connect();
  try {
    for (const sql of sqlChunks(demo)) { await db.query(sql); chunks++; }
  } finally {
    await db.end();
  }
  console.log(`Loaded in ${chunks} statements, ${((Date.now() - started) / 1000).toFixed(1)} s`);
}
if (!process.env.DEMO_STAFF_PASSWORD) console.log(`Staff logins (${demo.logins.staff.join(', ')}) password: ${staffPassword}`);
if (!process.env.DEMO_GUEST_PASSWORD) console.log(`Guest logins (${demo.logins.guests.join(', ')}) password: ${guestPassword}`);

// Starts a throwaway local Postgres (Docker) holding one empty venue database
// with the real schema and Client row, prints its URL, and removes it on
// Ctrl+C. Load it with build-sql.mjs --database-url to test queries at any size:
//   node bin/local-venue.mjs [--client demo]
//   node bin/build-sql.mjs --client demo --database-url <printed url> --tickets-per-live 1000
import { setupTestDatabase, teardownTestDatabase } from 'test-db-harness';
import { createDatabaseObjects, insertClientRecord } from '../../clientSetup-Teardown/src/index.js';
import { DEMO_VENUE } from '../src/generate.mjs';

const i = process.argv.indexOf('--client');
const client = i > -1 ? process.argv[i + 1] : 'demo';
const { dbConfig, containerName } = await setupTestDatabase({ dbName: client });
const stop = async () => { await teardownTestDatabase(containerName); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await createDatabaseObjects(dbConfig, client, DEMO_VENUE.theaterId, DEMO_VENUE.name, 'MQ');
await insertClientRecord(dbConfig, client, {
  username: client, clientSecret: 'local', contactName: 'Demo', clientEmail: 'demo@example.com',
  square_access_token: 'none', square_signature_key: 'none', sender_email: 'demo@example.com',
  theater_id: DEMO_VENUE.theaterId, theater_name: DEMO_VENUE.name, film_code_prefix: 'MQ'
});
const { user, password, host, port, database } = dbConfig;
console.log(`Venue database ready (container ${containerName}):`);
console.log(`postgres://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}`);
console.log('Ctrl+C removes it.');
setInterval(() => {}, 1 << 30);

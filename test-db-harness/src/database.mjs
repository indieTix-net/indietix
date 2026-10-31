import pg from 'pg';

const { Client } = pg;

// DDL identifiers (CREATE/DROP DATABASE) can't be parameterized with pg's
// $1-style placeholders -- they have to be interpolated into the SQL
// string. This is test tooling, not a public-facing surface, but a cheap
// allowlist check costs nothing and rules out any accidental mistake
// turning into a surprising DDL statement.
const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function assertSafeIdentifier(name) {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`Unsafe database identifier: "${name}" (must match ${SAFE_IDENTIFIER})`);
  }
}

/**
 * Creates a new, empty database on the given server. `adminConfig` should
 * point at the server's default admin database (test-db-harness's
 * startPostgresContainer() returns one with `database: 'postgres'` already
 * set) -- CREATE DATABASE can't run inside a transaction or against the
 * database being created.
 *
 * @param {Object} adminConfig - pg connection config
 * @param {string} dbName
 */
export async function createDatabase(adminConfig, dbName) {
  assertSafeIdentifier(dbName);
  const client = new Client(adminConfig);
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await client.end();
  }
}

/**
 * Drops a database, terminating any existing connections to it first
 * (Postgres refuses to drop a database with active connections).
 *
 * @param {Object} adminConfig - pg connection config
 * @param {string} dbName
 */
export async function dropDatabase(adminConfig, dbName) {
  assertSafeIdentifier(dbName);
  const client = new Client(adminConfig);
  await client.connect();
  try {
    await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
      [dbName]
    );
    await client.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  } finally {
    await client.end();
  }
}

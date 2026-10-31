export { startPostgresContainer, stopPostgresContainer } from './docker.mjs';
export { createDatabase, dropDatabase } from './database.mjs';

import { startPostgresContainer, stopPostgresContainer } from './docker.mjs';
import { createDatabase } from './database.mjs';

/**
 * Convenience wrapper for the common case: a fresh container, one named
 * database inside it, ready for the caller to run their own schema setup
 * against (e.g. clientSetup-Teardown's exported createDatabaseObjects).
 *
 * This package deliberately knows nothing about IndieTix's schema --
 * that's clientSetup-Teardown's job, kept as the single source of truth.
 * Call createDatabaseObjects(dbConfig, dbName, ...) yourself after this
 * resolves.
 *
 * @param {Object} [opts]
 * @param {string} [opts.dbName='test_db'] - must be a safe SQL identifier
 * @param {string} [opts.image='postgres:16']
 * @returns {Promise<{dbConfig: Object, containerName: string}>}
 *   dbConfig has `database` set to dbName, ready to use directly.
 */
export async function setupTestDatabase({ dbName = 'test_db', image } = {}) {
  const { dbConfig: adminConfig, containerName } = await startPostgresContainer({ image });
  await createDatabase(adminConfig, dbName);
  return {
    dbConfig: { ...adminConfig, database: dbName },
    containerName
  };
}

/**
 * Tears down everything setupTestDatabase() started. The container was
 * started with --rm, so stopping it also removes it -- no separate
 * dropDatabase() call needed.
 *
 * @param {string} containerName
 */
export async function teardownTestDatabase(containerName) {
  await stopPostgresContainer(containerName);
}

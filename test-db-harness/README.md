# test-db-harness

**Last Edited:** 2026-10-28

Disposable, local, real Postgres containers for IndieTix's test suites.

## Why this exists

Most of this platform's correctness lives in SQL, not JS -- the box-office reporting functions (`bdor_for_date` etc.), JSONB columns, and the no-foreign-key referential integrity convention that's enforced entirely in application code. Mocking `pg`/Sequelize for this gives false confidence: a test can pass against a fake query response while the real SQL is actually broken. A real Postgres engine is the only thing that means anything here.

This package deliberately knows **nothing** about IndieTix's own schema. That stays `clientSetup-Teardown`'s job (`createDatabaseObjects`, exported for exactly this reason) -- the single source of truth for what a client database looks like doesn't get a second copy here. This package's only job is: start a real, disposable Postgres container, create/drop databases in it, and get out of the way.

Chosen specifically because it has **zero path to touching production**: not an AWS resource, no credentials, no network reachability to anything real. A `postgres:16` Docker image matching Aurora's actual engine version (`16.11`, confirmed via `aws rds describe-db-clusters`), running only on `127.0.0.1`.

## What's in it

- `startPostgresContainer({ image })` -- starts a fresh `postgres:16` container on a free local port, waits until it accepts connections, returns `{ dbConfig, containerName }` (`dbConfig` points at the default `postgres` admin database).
- `stopPostgresContainer(containerName)` -- stops it (started with `--rm`, so stopping also removes it).
- `createDatabase(adminConfig, dbName)` / `dropDatabase(adminConfig, dbName)` -- create/drop a named database on a running container.
- `setupTestDatabase({ dbName, image })` / `teardownTestDatabase(containerName)` -- the convenience wrapper most tests want: starts a container, creates one named database, returns a `dbConfig` with `database` already set to it. Callers run their own schema setup against that (see below) before using it.

## Using this with a real schema

```js
import { setupTestDatabase, teardownTestDatabase } from 'test-db-harness';
import { createDatabaseObjects } from '../../clientSetup-Teardown/src/index.js';

let dbConfig, containerName;

before(async () => {
  ({ dbConfig, containerName } = await setupTestDatabase({ dbName: 'my_test_db' }));
  await createDatabaseObjects(dbConfig, 'my_test_db', /* theaterId */ 1, 'Test Theatre', 'TT');
});

after(async () => {
  await teardownTestDatabase(containerName);
});
```

Every repo in this workspace lives as a sibling directory, so the relative `require`/`import` path to `clientSetup-Teardown`'s exported function works directly -- no npm package needed for that part.

Each test file gets its own fresh container (a few seconds of startup cost, paid once per file) rather than sharing one container across a whole test run -- simpler, and fully isolated between test files with no risk of one file's leftover state leaking into another's.

## Tests

```
npm install
npm test
```

Requires Docker running locally. These are real integration tests of the harness itself (start a container, create/drop a database, confirm readiness-waiting and cleanup actually work) -- not mocked, since the whole point of this package is to be the real thing.

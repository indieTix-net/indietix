import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Client } = pg;

const DEFAULT_IMAGE = 'postgres:16';
const DEFAULT_PASSWORD = 'test-db-harness-password';
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_INTERVAL_MS = 300;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
    });
  });
}

// Docker picks the host port itself when it binds (`-p 127.0.0.1::5432`), then
// reports it. Picking a free port ourselves and passing it in left a gap
// where a parallel test file could be handed the same one ("address already
// in use" when QRScanner's test files start their containers at once).
async function publishedPort(containerName) {
  const { stdout } = await run('docker', ['port', containerName, '5432/tcp']);
  const line = stdout.split('\n').find((l) => l.startsWith('127.0.0.1:')) || stdout.split('\n')[0];
  const port = Number(line.slice(line.lastIndexOf(':') + 1));
  if (!Number.isInteger(port) || port <= 0) throw new Error(`Could not read the published port of ${containerName}: "${stdout}"`);
  return port;
}

async function waitUntilReady(dbConfig, deadline) {
  let lastError;
  while (Date.now() < deadline) {
    const client = new Client(dbConfig);
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (err) {
      lastError = err;
      try { await client.end(); } catch { /* already broken, ignore */ }
      await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
    }
  }
  throw new Error(`Postgres container did not become ready in time: ${lastError?.message}`);
}

/**
 * Starts a disposable postgres container on a free local port and waits
 * until it accepts connections.
 *
 * @param {Object} [opts]
 * @param {string} [opts.image='postgres:16']
 * @returns {Promise<{dbConfig: Object, containerName: string}>}
 *   dbConfig is ready to pass to `pg`'s Client/Pool -- includes `database:
 *   'postgres'` (the default admin DB), override it per-call for anything
 *   else.
 */
export async function startPostgresContainer({ image = DEFAULT_IMAGE } = {}) {
  const containerName = `test-db-harness-${randomUUID().slice(0, 8)}`;

  await run('docker', [
    'run', '-d', '--rm',
    '--name', containerName,
    '-e', `POSTGRES_PASSWORD=${DEFAULT_PASSWORD}`,
    '-p', '127.0.0.1::5432',
    image
  ]);

  let port;
  try {
    port = await publishedPort(containerName);
  } catch (err) {
    await stopPostgresContainer(containerName).catch(() => {});
    throw err;
  }

  const dbConfig = {
    host: '127.0.0.1',
    port,
    user: 'postgres',
    password: DEFAULT_PASSWORD,
    database: 'postgres',
    ssl: false
  };

  try {
    await waitUntilReady(dbConfig, Date.now() + READY_TIMEOUT_MS);
  } catch (err) {
    // Don't leave a half-started container behind on failure.
    await stopPostgresContainer(containerName).catch(() => {});
    throw err;
  }

  return { dbConfig, containerName };
}

/**
 * Stops and removes (via --rm) a container started by startPostgresContainer.
 * @param {string} containerName
 */
export async function stopPostgresContainer(containerName) {
  await run('docker', ['stop', containerName]);
}

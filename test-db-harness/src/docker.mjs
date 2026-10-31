import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
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

// Binds to port 0 to ask the OS for a free ephemeral port, then releases it
// immediately. There's a small window where another process could grab the
// same port before `docker run` binds it (TOCTOU) -- acceptable for test
// tooling; a real production bind-address allocator this is not.
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
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
  const port = await pickFreePort();
  const containerName = `test-db-harness-${randomUUID().slice(0, 8)}`;

  await run('docker', [
    'run', '-d', '--rm',
    '--name', containerName,
    '-e', `POSTGRES_PASSWORD=${DEFAULT_PASSWORD}`,
    '-p', `127.0.0.1:${port}:5432`,
    image
  ]);

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

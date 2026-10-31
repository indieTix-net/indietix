// Sandbox-only testing utility -- NOT part of the real indieTix Lambda set.
// Runs one ad hoc parameterized SQL statement against a named client
// database, using this environment's own Aurora master credentials
// (DB_ADMIN_SECRET_ARN + DB_HOST, set by the template; the fixed-name
// indietix secret is only a fallback for environments that predate it). Exists purely to seed
// test data (e.g. a Users row) that none of the real Lambdas create
// themselves, since the sandbox Aurora cluster has no direct/public
// access for a local psql session.
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import pg from 'pg';

const { Pool } = pg;
const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION });

export const handler = async (event) => {
  const useEnvCluster = Boolean(process.env.DB_ADMIN_SECRET_ARN && process.env.DB_HOST);
  const secretResponse = await secretsClient.send(new GetSecretValueCommand({
    SecretId: useEnvCluster ? process.env.DB_ADMIN_SECRET_ARN : 'indieTix/rds/clients/indietix/credentials'
  }));
  const secret = JSON.parse(secretResponse.SecretString);
  const creds = useEnvCluster
    ? { host: process.env.DB_HOST, port: process.env.DB_PORT || '5432', username: secret.username, password: secret.password, ssl: 'true' }
    : secret;

  const pool = new Pool({
    host: creds.host,
    port: parseInt(creds.port || '5432'),
    database: event.database,
    user: creds.username,
    password: creds.password,
    ssl: creds.ssl === 'true' ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 20000 // covers an auto-paused sandbox cluster resuming (~15s)
  });

  try {
    const result = await pool.query(event.sql, event.params || []);
    return { statusCode: 200, rows: result.rows, rowCount: result.rowCount };
  } finally {
    await pool.end();
  }
};

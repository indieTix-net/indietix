import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import pg from "pg";

const { Pool } = pg;
const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION });

export const handler = async () => {
  const secretResponse = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ARN })
  );
  const creds = JSON.parse(secretResponse.SecretString);

  const pool = new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || "5432"),
    database: process.env.DB_NAME || "postgres",
    user: creds.username,
    password: creds.password,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000
  });

  try {
    const result = await pool.query("SELECT version(), now();");
    console.log("Connected successfully:", JSON.stringify(result.rows[0]));
    return { statusCode: 200, body: JSON.stringify(result.rows[0]) };
  } finally {
    await pool.end();
  }
};

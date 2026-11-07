// Database access for the support inbox: the `indietix` platform database,
// through the RDS Data API (HTTPS, so no VPC or connection pool). SQL uses
// named parameters (:name); values are strings, numbers, booleans or null.
// Tests swap in a pg-backed query function with createPgQuery.

import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';

function toDataApiParam(name, value) {
  if (value === null || value === undefined) return { name, value: { isNull: true } };
  if (typeof value === 'number' && Number.isInteger(value)) return { name, value: { longValue: value } };
  if (typeof value === 'number') return { name, value: { doubleValue: value } };
  if (typeof value === 'boolean') return { name, value: { booleanValue: value } };
  return { name, value: { stringValue: String(value) } };
}

// query(sql, params) -> array of row objects
export function createDataApiQuery({ resourceArn, secretArn, database, region, client }) {
  const rds = client || new RDSDataClient({ region });
  return async (sql, params = {}) => {
    const response = await rds.send(new ExecuteStatementCommand({
      resourceArn, secretArn, database, sql,
      parameters: Object.entries(params).map(([name, value]) => toDataApiParam(name, value)),
      formatRecordsAs: 'JSON'
    }));
    return response.formattedRecords ? JSON.parse(response.formattedRecords) : [];
  };
}

// Same interface over a pg client, for tests against a real Postgres.
export function createPgQuery(pgClient) {
  return async (sql, params = {}) => {
    const names = [];
    const text = sql.replace(/(?<!:):([A-Za-z_][A-Za-z0-9_]*)/g, (match, name) => {
      let index = names.indexOf(name);
      if (index === -1) { names.push(name); index = names.length - 1; }
      return `$${index + 1}`;
    });
    const result = await pgClient.query(text, names.map(name => params[name] ?? null));
    return result.rows;
  };
}

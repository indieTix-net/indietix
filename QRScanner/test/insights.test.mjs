import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer } from './helpers/testServer.mjs';

let ctx;
let originalFetch;

before(async () => {
  ctx = await startTestServer({ clientConfig: { ANTHROPIC_API_KEY: 'test-anthropic-key' } });
});
after(async () => { await stopTestServer(ctx); });

beforeEach(async () => {
  await ctx.pgClient.query(`DELETE FROM "QRCodeProduct"`);
  originalFetch = globalThis.fetch;
});

function installAnthropicMock({ sqlText, formattingOk = true, answerText = 'Here is your answer.', sqlOk = true, sqlStatus = 200, formattingStatus = 200 }) {
  globalThis.fetch = async (url, opts) => {
    if (url === 'https://api.anthropic.com/v1/messages') {
      const body = JSON.parse(opts.body);
      const isFormatting = Array.isArray(body.tools);
      if (!isFormatting) {
        if (!sqlOk) return { ok: false, status: sqlStatus, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ content: [{ text: sqlText }] }) };
      }
      if (!formattingOk) return { ok: false, status: formattingStatus, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: answerText }] }) };
    }
    return originalFetch(url, opts);
  };
}

test('POST /api/insights/query: happy path generates SQL, runs it, and returns a formatted answer', async () => {
  await ctx.pgClient.query(
    `INSERT INTO "QRCodeProduct" ("QRCode", "ExpirationDate", "ProductDate", "ProductName", "ProductLocation", "ProductType", "ProductDetails", "ProductID", "Status")
     VALUES ('QR-INSIGHT-1', '2099-01-01', '2026-01-01 19:00:00', 'Test Movie', 'Main', 'Movie', 'details', 'ITEM', 'valid')`
  );
  installAnthropicMock({ sqlText: `SELECT COUNT(*) FROM "QRCodeProduct" WHERE "ProductType" = 'Movie'`, answerText: 'There is 1 movie ticket sold.' });

  try {
    const { status, json } = await ctx.request('POST', '/api/insights/query', { token: ctx.clientToken, body: { question: 'How many movie tickets sold?' } });
    assert.equal(status, 200);
    assert.equal(json.answer, 'There is 1 movie ticket sold.');
    assert.equal(json.rowCount, 1);
    assert.match(json.sql, /SELECT COUNT/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /api/insights/query: missing question is a 400', async () => {
  const { status } = await ctx.request('POST', '/api/insights/query', { token: ctx.clientToken, body: {} });
  assert.equal(status, 400);
});

test('POST /api/insights/query: a non-SELECT generated query is rejected with 400, never executed', async () => {
  installAnthropicMock({ sqlText: `DELETE FROM "QRCodeProduct"` });
  try {
    const { status, json } = await ctx.request('POST', '/api/insights/query', { token: ctx.clientToken, body: { question: 'delete everything' } });
    assert.equal(status, 400);
    assert.match(json.error, /SELECT/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /api/insights/query: a SELECT query containing a forbidden keyword in a subquery is still rejected', async () => {
  installAnthropicMock({ sqlText: `SELECT * FROM "QRCodeProduct" WHERE 1=1; DROP TABLE "QRCodeProduct";` });
  try {
    const { status, json } = await ctx.request('POST', '/api/insights/query', { token: ctx.clientToken, body: { question: 'sneaky' } });
    assert.equal(status, 400);
    assert.match(json.error, /forbidden operation/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /api/insights/query: strips markdown code fences from the generated SQL before running it', async () => {
  installAnthropicMock({ sqlText: '```sql\nSELECT COUNT(*) FROM "QRCodeProduct"\n```' });
  try {
    const { status, json } = await ctx.request('POST', '/api/insights/query', { token: ctx.clientToken, body: { question: 'count tickets' } });
    assert.equal(status, 200);
    assert.equal(json.sql.includes('```'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /api/insights/query: a Claude SQL-generation failure surfaces as a 500', async () => {
  installAnthropicMock({ sqlOk: false, sqlStatus: 500 });
  try {
    const { status, json } = await ctx.request('POST', '/api/insights/query', { token: ctx.clientToken, body: { question: 'anything' } });
    assert.equal(status, 500);
    assert.match(json.error, /Failed to generate insights/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /api/insights/query: invalid generated SQL (fails to execute) surfaces as a 500, not a crash', async () => {
  installAnthropicMock({ sqlText: `SELECT * FROM "NotARealTable"` });
  try {
    const { status } = await ctx.request('POST', '/api/insights/query', { token: ctx.clientToken, body: { question: 'anything' } });
    assert.equal(status, 500);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /api/insights/query: a Claude formatting-step failure surfaces as a 500 (SQL already ran successfully)', async () => {
  installAnthropicMock({ sqlText: `SELECT COUNT(*) FROM "QRCodeProduct"`, formattingOk: false, formattingStatus: 500 });
  try {
    const { status } = await ctx.request('POST', '/api/insights/query', { token: ctx.clientToken, body: { question: 'anything' } });
    assert.equal(status, 500);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---- Hardening (2026-10-29): the database enforces read-only, not just keywords ----

test('POST /api/insights/query: multiple statements are rejected before execution', async () => {
  installAnthropicMock({ sqlText: `SELECT 1; COMMIT; DELETE FROM "QRCodeProduct"` });
  try {
    const { status } = await ctx.request('POST', '/api/insights/query', { token: ctx.clientToken, body: { question: 'sneaky' } });
    assert.equal(status, 400);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /api/insights/query: queries touching the Users or Client tables are refused', async () => {
  for (const sqlText of [`SELECT "Password" FROM "Users"`, `SELECT "clientSecret" FROM "Client"`]) {
    installAnthropicMock({ sqlText });
    try {
      const { status } = await ctx.request('POST', '/api/insights/query', { token: ctx.clientToken, body: { question: 'creds?' } });
      assert.equal(status, 400, sqlText);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

test('POST /api/insights/query: API keys, skeleton keys and link tokens are refused too', async () => {
  for (const sqlText of [
    `SELECT "KeyHash" FROM "ApiKey"`,
    `SELECT * FROM "ApiIdempotency"`,
    `SELECT "QRCode" FROM "SkeletonKey"`,
    `SELECT "OptInToken" FROM "Order"`,
    `SELECT "UnsubscribeToken" FROM "MarketingEmailContact"`
  ]) {
    installAnthropicMock({ sqlText });
    try {
      const { status } = await ctx.request('POST', '/api/insights/query', { token: ctx.clientToken, body: { question: 'secrets?' } });
      assert.equal(status, 400, sqlText);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

test("POST /api/insights/query: the SQL step is told about this venue's own name, address and rooms, and the real schema", async () => {
  await ctx.pgClient.query(`UPDATE "Client" SET "configuration" = "configuration"::jsonb || $1::jsonb`, [JSON.stringify({ LEGAL_ADDRESS: '1 Main St, Springfield, IL', EVENT_LOCATIONS: ['Big Room', 'Small Room'] })]);
  let prompt = '';
  globalThis.fetch = async (url, opts) => {
    if (url === 'https://api.anthropic.com/v1/messages') {
      const body = JSON.parse(opts.body);
      if (!Array.isArray(body.tools)) {
        prompt = JSON.stringify(body);
        return { ok: true, status: 200, json: async () => ({ content: [{ text: 'SELECT 1' }] }) };
      }
      return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'ok' }] }) };
    }
    return originalFetch(url, opts);
  };
  try {
    const { status } = await ctx.request('POST', '/api/insights/query', { token: ctx.clientToken, body: { question: 'How many?' } });
    assert.equal(status, 200);
    assert.match(prompt, /Test Venue at 1 Main St, Springfield, IL/);
    assert.match(prompt, /\\"Big Room\\", \\"Small Room\\"/);
    assert.match(prompt, /\\"OrderID\\" \(INTEGER\) -> \\"Order\\".\\"ID\\"/);
    assert.match(prompt, /ProductSeatCode/);
    assert.match(prompt, /America\/Chicago/);
    assert.doesNotMatch(prompt, /lawrence|TicketHolderName|Spacement/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /api/insights/query: a write that slips past the keyword list is still blocked by the read-only transaction', async () => {
  await ctx.pgClient.query(
    `INSERT INTO "QRCodeProduct" ("QRCode", "ExpirationDate", "ProductDate", "ProductName", "ProductLocation", "ProductType", "ProductDetails", "ProductID", "Status")
     VALUES ('QR-RO-1', '2099-01-01', '2026-01-01 19:00:00', 'Test Movie', 'Main', 'Movie', 'details', 'ITEM', 'valid')`
  );
  // nextval() is a write hiding inside a plain SELECT -- no keyword list
  // catches it; only the READ ONLY transaction does.
  installAnthropicMock({ sqlText: `SELECT nextval('"QRCodeProduct_ID_seq"')` });
  try {
    const { status, json } = await ctx.request('POST', '/api/insights/query', { token: ctx.clientToken, body: { question: 'bump a sequence' } });
    assert.equal(status, 500, 'nextval is a write; READ ONLY must reject it');
    assert.match(json.error, /read-only transaction/, 'must fail BECAUSE of read-only, not some other error');
  } finally {
    globalThis.fetch = originalFetch;
  }
  const rows = await ctx.pgClient.query(`SELECT COUNT(*)::int AS n FROM "QRCodeProduct"`);
  assert.equal(rows.rows[0].n, 1);
});


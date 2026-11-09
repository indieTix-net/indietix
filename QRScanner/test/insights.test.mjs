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

let formattingPrompts = [];
let formattingBodies = [];
let sqlPrompts = [];
function installAnthropicMock({ sqlText, sqlContent, formattingOk = true, answerText = 'Here is your answer.', sqlOk = true, sqlStatus = 200, formattingStatus = 200 }) {
  formattingPrompts = [];
  formattingBodies = [];
  sqlPrompts = [];
  globalThis.fetch = async (url, opts) => {
    if (url === 'https://api.anthropic.com/v1/messages') {
      const body = JSON.parse(opts.body);
      const isFormatting = Array.isArray(body.tools);
      if (isFormatting) { formattingPrompts.push(body.messages[0].content); formattingBodies.push(body); } else sqlPrompts.push(body.messages[0].content);
      if (!isFormatting) {
        if (!sqlOk) return { ok: false, status: sqlStatus, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ content: sqlContent || [{ text: sqlText }] }) };
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


// ---- questions the data can't answer exactly (no genre column, say) ----

async function insertMovieTicket(qr, distributor) {
  await ctx.pgClient.query(
    `INSERT INTO "QRCodeProduct" ("QRCode", "ExpirationDate", "ProductDate", "ProductName", "ProductLocation", "ProductType", "ProductDetails", "ProductID", "Status", "Distributor")
     VALUES ($1, '2099-01-01', '2026-01-01 19:00:00', 'Test Movie', 'Main', 'Movie', 'details', 'ITEM', 'valid', $2)`, [qr, distributor]);
}

test('POST /api/insights/query: an explanation before the query (the real "best selling genres" reply) runs the closest query and passes the note on', async () => {
  await insertMovieTicket('QR-GENRE-1', 'Big Sky Studios');
  installAnthropicMock({
    sqlText: `I don't have enough information to answer this: there is no genre column in the schema, so movie genre cannot be determined. Here's the closest available substitute, ranking by distributor instead:\n\nSELECT "Distributor", COUNT(*) AS tickets_sold\nFROM "QRCodeProduct"\nWHERE "ProductType" = 'Movie' AND "Status" = 'valid'\nGROUP BY "Distributor"\nORDER BY tickets_sold DESC\nLIMIT 10;`,
    answerText: 'Your data has no genres; by distributor, Big Sky Studios sold the most.'
  });
  try {
    const { status, json } = await ctx.request('POST', '/api/insights/query', { token: ctx.clientToken, body: { question: 'What are the best selling movie genres?' } });
    assert.equal(status, 200);
    assert.equal(json.rowCount, 1);
    assert.match(json.sql, /^SELECT "Distributor"/);
    assert.match(formattingPrompts[0], /Note from the query writer: I don't have enough information.*no genre column/s);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /api/insights/query: a NOTE line then a query; and a NOTE with no query answers in plain words', async () => {
  await insertMovieTicket('QR-NOTE-1', 'Paper Moon Films');
  installAnthropicMock({ sqlText: `NOTE: Genres aren't recorded; showing ticket sales by film instead.\nSELECT "ProductName", COUNT(*) FROM "QRCodeProduct" GROUP BY "ProductName"` });
  try {
    const withQuery = await ctx.request('POST', '/api/insights/query', { token: ctx.clientToken, body: { question: 'genres?' } });
    assert.equal(withQuery.status, 200);
    assert.match(withQuery.json.sql, /^SELECT "ProductName"/);
    assert.match(formattingPrompts[0], /Genres aren't recorded/);
  } finally {
    globalThis.fetch = originalFetch;
  }
  installAnthropicMock({ sqlText: `NOTE: The data has no weather information, so this can't be answered from your sales.` });
  try {
    const noQuery = await ctx.request('POST', '/api/insights/query', { token: ctx.clientToken, body: { question: 'Do rainy days sell more?' } });
    assert.equal(noQuery.status, 200);
    assert.equal(noQuery.json.sql, null);
    assert.equal(noQuery.json.answer, "The data has no weather information, so this can't be answered from your sales.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /api/insights/query: a WITH query is accepted (still read-only)', async () => {
  await insertMovieTicket('QR-WITH-1', 'Juniper Films');
  installAnthropicMock({ sqlText: `WITH t AS (SELECT "Distributor" FROM "QRCodeProduct") SELECT "Distributor", COUNT(*) FROM t GROUP BY 1` });
  try {
    const { status, json } = await ctx.request('POST', '/api/insights/query', { token: ctx.clientToken, body: { question: 'by distributor' } });
    assert.equal(status, 200);
    assert.equal(json.rowCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /api/insights/query: sales mixed with outside facts (moon phases) get the sales by date, and the web-search step gets the venue location', async () => {
  await insertMovieTicket('QR-MOON-1', 'Northlight Pictures');
  await ctx.pgClient.query(`UPDATE "Client" SET "configuration" = ("configuration"::jsonb || '{"LEGAL_ADDRESS": "100 Example Street, Riverton, KS"}'::jsonb)::json`);
  installAnthropicMock({
    sqlText: `SELECT "ProductDate"::date AS show_date, COUNT(*) AS tickets FROM "QRCodeProduct" WHERE "Status" = 'valid' GROUP BY 1 ORDER BY 1`,
    answerText: 'Full moons sold the most tickets.'
  });
  try {
    const { status, json } = await ctx.request('POST', '/api/insights/query', { token: ctx.clientToken, body: { question: 'What phase of the moon is best for selling movie tickets?' } });
    assert.equal(status, 200);
    assert.equal(json.answer, 'Full moons sold the most tickets.');
    assert.match(sqlPrompts[0], /can search the web.*moon phases.*tickets and revenue per show date/s);
    assert.match(formattingPrompts[0], /The venue is .*100 Example Street, Riverton, KS; use that location when searching the web/);
    assert.doesNotMatch(formattingPrompts[0], /Note from the query writer/);
  } finally {
    globalThis.fetch = originalFetch;
    await ctx.pgClient.query(`UPDATE "Client" SET "configuration" = ("configuration"::jsonb - 'LEGAL_ADDRESS')::json`);
  }
});

test('POST /api/insights/query: a reply that starts with a thinking block (the real moon-phase failure) still works', async () => {
  await insertMovieTicket('QR-THINK-1', 'Northlight Pictures');
  installAnthropicMock({
    sqlContent: [
      { type: 'thinking', thinking: 'Moon phases come from the web; return tickets per show date.', signature: 'sig' },
      { type: 'text', text: `SELECT "ProductDate"::date AS show_date, COUNT(*) AS tickets FROM "QRCodeProduct" GROUP BY 1` }
    ],
    answerText: 'Full moons sold best.'
  });
  try {
    const { status, json } = await ctx.request('POST', '/api/insights/query', { token: ctx.clientToken, body: { question: 'what phases of the moon sell the best movie tickets ?' } });
    assert.equal(status, 200);
    assert.equal(json.answer, 'Full moons sold best.');
    assert.match(json.sql, /^SELECT "ProductDate"::date/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /api/insights/query: a reply with no text at all is a clear message, not a crash', async () => {
  installAnthropicMock({ sqlContent: [{ type: 'thinking', thinking: 'hmm', signature: 'sig' }] });
  try {
    const { status, json } = await ctx.request('POST', '/api/insights/query', { token: ctx.clientToken, body: { question: 'anything' } });
    assert.equal(status, 502);
    assert.match(json.error, /Try rephrasing/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /api/insights/query: the answer step is kept quick (low effort, at most 3 searches, moon phases worked out not searched)', async () => {
  await insertMovieTicket('QR-QUICK-1', 'Northlight Pictures');
  installAnthropicMock({ sqlText: `SELECT "ProductDate"::date AS d, COUNT(*) FROM "QRCodeProduct" GROUP BY 1` });
  try {
    const { status } = await ctx.request('POST', '/api/insights/query', { token: ctx.clientToken, body: { question: 'moon phases and sales' } });
    assert.equal(status, 200);
    const body = formattingBodies[0];
    assert.deepEqual(body.output_config, { effort: 'low' });
    assert.equal(body.tools[0].max_uses, 3);
    assert.equal(body.tools[0].user_location.timezone, 'America/Chicago');
    assert.match(formattingPrompts[0], /moon phases.*repeat every 29\.53 days/s);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /api/insights/query: an answer step that runs too long is stopped with a clear message, not a timeout', async () => {
  await insertMovieTicket('QR-SLOW-1', 'Northlight Pictures');
  process.env.INSIGHTS_ANSWER_TIMEOUT_MS = '200';
  globalThis.fetch = async (url, opts) => {
    if (url !== 'https://api.anthropic.com/v1/messages') return originalFetch(url, opts);
    const body = JSON.parse(opts.body);
    if (!Array.isArray(body.tools)) return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'SELECT 1 AS one' }] }) };
    return new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  };
  try {
    const { status, json } = await ctx.request('POST', '/api/insights/query', { token: ctx.clientToken, body: { question: 'slow one' } });
    assert.equal(status, 504);
    assert.match(json.error, /took too long.*shorter date range/);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.INSIGHTS_ANSWER_TIMEOUT_MS;
  }
});

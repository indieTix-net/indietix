// The support inbox, run on your own computer: `./support.sh` in
// infrastructure/. Listens on 127.0.0.1 only, behind a random key in the
// address, and uses your own AWS credentials, so there's no new login on
// the internet. Lists tickets, shows each conversation with the drafted
// reply, and sends your edited reply from support@indietix.net.

import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { createDataApiQuery } from '../src/db.mjs';
import { listTickets, getTicket, getMessages, addMessage, setStatus } from '../src/store.mjs';
import { buildReplyMime, replySubject, SUPPORT_ADDRESS } from '../src/mail.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const STATUSES = new Set(['open', 'waiting', 'closed', 'spam']);

export function createInboxServer({ query, sendRaw, redraft, bcc, sender = os.userInfo().username, key = crypto.randomBytes(24).toString('base64url') }) {
  const page = fs.readFileSync(path.join(here, 'index.html'), 'utf8');

  async function send(ticketId, body) {
    const ticket = await getTicket(query, ticketId);
    if (!ticket) return [404, { error: 'Ticket not found' }];
    if (!body || !body.trim()) return [400, { error: 'The reply is empty' }];
    const messages = await getMessages(query, ticketId);
    const latestIn = [...messages].reverse().find(m => m.Direction === 'in');
    const thread = messages.flatMap(m => [m.InReplyTo, m.MessageID]).filter(Boolean);
    const mime = buildReplyMime({
      to: ticket.CustomerEmail, toName: ticket.CustomerName,
      subject: replySubject(latestIn?.Subject || ticket.Subject, ticket.ID),
      body, inReplyTo: latestIn?.MessageID, references: thread, bcc,
      quoted: latestIn && { bodyText: latestIn.BodyText, fromName: latestIn.FromName, fromAddress: latestIn.FromAddress, date: latestIn.CreatedDate }
    });
    await sendRaw(mime);
    await addMessage(query, ticket.ID, {
      direction: 'out', messageId: mime.messageId, inReplyTo: latestIn?.MessageID, fromAddress: SUPPORT_ADDRESS,
      fromName: 'IndieTix Support', toAddresses: ticket.CustomerEmail, subject: replySubject(latestIn?.Subject || ticket.Subject, ticket.ID),
      bodyText: body.trim(), sentBy: sender
    });
    return [200, { sent: true }];
  }

  async function route(req, url, body) {
    const parts = url.pathname.split('/').filter(Boolean); // api, tickets, :id, action
    if (req.method === 'GET' && url.pathname === '/api/tickets') {
      const status = url.searchParams.get('status');
      return [200, { tickets: await listTickets(query, { status: STATUSES.has(status) ? status : null }) }];
    }
    if (parts[0] === 'api' && parts[1] === 'tickets' && /^\d+$/.test(parts[2] || '')) {
      const id = Number(parts[2]);
      if (req.method === 'GET' && parts.length === 3) {
        const ticket = await getTicket(query, id);
        return ticket ? [200, { ticket, messages: await getMessages(query, id) }] : [404, { error: 'Ticket not found' }];
      }
      if (req.method === 'POST' && parts[3] === 'send') return send(id, body.body);
      if (req.method === 'POST' && parts[3] === 'redraft') return [200, await redraft(id)];
      if (req.method === 'POST' && parts[3] === 'status') {
        if (!STATUSES.has(body.status)) return [400, { error: 'Unknown status' }];
        return [200, { ticket: await setStatus(query, id, body.status) }];
      }
    }
    return [404, { error: 'Not found' }];
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const reply = (status, data, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
      res.end(type === 'application/json' ? JSON.stringify(data) : data);
    };
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        return url.searchParams.get('key') === key ? reply(200, page, 'text/html; charset=utf-8') : reply(403, 'Open the address support.sh printed.', 'text/plain');
      }
      // API calls carry the key in a header, so another site open in the
      // browser can't make them.
      const given = Buffer.from(String(req.headers['x-inbox-key'] || ''));
      const want = Buffer.from(key);
      if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return reply(403, { error: 'Forbidden' });
      let body = {};
      if (req.method === 'POST') {
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (raw.length > 1e6) return reply(413, { error: 'Too large' }); }
        body = raw ? JSON.parse(raw) : {};
      }
      const [status, data] = await route(req, url, body);
      reply(status, data);
    } catch (error) {
      console.error(error);
      reply(500, { error: error.message });
    }
  });
  return { server, key };
}

// ---- Run it ----
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = (name) => { if (!process.env[name]) { console.error(`Missing ${name} (set in deploy.config.sh, see CHEATSHEET.md)`); process.exit(2); } return process.env[name]; };
  const region = process.env.SUPPORT_REGION || 'us-east-2';
  const ses = new SESClient({ region });
  const lambda = new LambdaClient({ region });
  const functionName = env('SUPPORT_FUNCTION');
  const { server, key } = createInboxServer({
    query: createDataApiQuery({ resourceArn: env('SUPPORT_DB_CLUSTER_ARN'), secretArn: env('SUPPORT_DB_SECRET_ARN'), database: process.env.SUPPORT_DB_NAME || 'indietix', region }),
    sendRaw: async ({ raw, destinations }) => {
      await ses.send(new SendRawEmailCommand({ Source: SUPPORT_ADDRESS, Destinations: destinations, RawMessage: { Data: Buffer.from(raw) } }));
    },
    redraft: async (ticketId) => {
      const result = await lambda.send(new InvokeCommand({ FunctionName: functionName, Payload: Buffer.from(JSON.stringify({ action: 'draft', ticketId })) }));
      return JSON.parse(Buffer.from(result.Payload).toString() || '{}');
    },
    bcc: process.env.SUPPORT_BCC || null
  });
  server.listen(0, '127.0.0.1', () => {
    const address = `http://127.0.0.1:${server.address().port}/?key=${key}`;
    console.log(`Support inbox: ${address}\n(Ctrl+C to stop)`);
    import('child_process').then(({ spawn }) => spawn('open', [address], { stdio: 'ignore', detached: true }).unref()).catch(() => {});
  });
}

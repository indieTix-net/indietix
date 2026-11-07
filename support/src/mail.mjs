// Email in and out for the support inbox: parse an incoming message, decide
// whether it gets a draft, and build a threaded reply.

import { simpleParser } from 'mailparser';
import crypto from 'crypto';

export const SUPPORT_ADDRESS = 'support@indietix.net';
export const OWN_DOMAIN = 'indietix.net';
const MAX_BODY_CHARS = 50000;

const TICKET_TOKEN = /\[T-(\d+)\]/i;
export const ticketNumberFromSubject = (subject) => {
  const match = TICKET_TOKEN.exec(subject || '');
  return match ? Number(match[1]) : null;
};

const ids = (value) => (Array.isArray(value) ? value : String(value || '').split(/\s+/)).map(s => s.trim()).filter(Boolean);

export async function parseEmail(raw) {
  const parsed = await simpleParser(raw);
  const from = parsed.from?.value?.[0] || {};
  const header = (name) => parsed.headers.get(name);
  const text = (parsed.text || '').replace(/\r\n?/g, '\n').trim();
  return {
    messageId: parsed.messageId || null,
    inReplyTo: parsed.inReplyTo || null,
    references: [...new Set([...ids(parsed.inReplyTo), ...ids(parsed.references)])],
    fromAddress: (from.address || '').toLowerCase(),
    fromName: from.name || null,
    toAddresses: (parsed.to?.value || []).map(t => t.address).filter(Boolean).join(', '),
    subject: parsed.subject || '',
    date: parsed.date || null,
    bodyText: text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) + '\n[... cut off]' : text,
    attachments: (parsed.attachments || []).map(a => ({ filename: a.filename || '(unnamed)', contentType: a.contentType, size: a.size })),
    headers: {
      autoSubmitted: String(header('auto-submitted') || '').toLowerCase(),
      precedence: String(header('precedence') || '').toLowerCase(),
      // mailparser gathers List-Id, List-Unsubscribe etc. under one "list" header.
      listId: Boolean(header('list')?.id || header('list-id')),
      listUnsubscribe: Boolean(header('list')?.unsubscribe || header('list-unsubscribe')),
      xAutoreply: header('x-autoreply') || header('x-autorespond') ? true : false
    }
  };
}

// Why an email gets stored but no draft, or null when it should get one.
// receipt is the SES receipt (spam/virus verdicts), when there is one.
export function skipReason(email, receipt) {
  if (receipt?.virusVerdict?.status === 'FAIL') return 'virus';
  if (receipt?.spamVerdict?.status === 'FAIL') return 'spam';
  const from = email.fromAddress || '';
  if (!from) return 'no_sender';
  if (from.endsWith(`@${OWN_DOMAIN}`)) return 'own_address';
  if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)@/i.test(from)) return 'automated_sender';
  const h = email.headers || {};
  if (h.autoSubmitted && h.autoSubmitted !== 'no') return 'auto_reply';
  if (h.xAutoreply) return 'auto_reply';
  if (['bulk', 'list', 'junk', 'auto_reply'].includes(h.precedence)) return 'bulk';
  if (h.listId || h.listUnsubscribe) return 'bulk';
  return null;
}

export function replySubject(subject, ticketId) {
  let s = (subject || '').trim() || '(no subject)';
  if (!/^re:/i.test(s)) s = `Re: ${s}`;
  if (!ticketNumberFromSubject(s)) s = `${s} [T-${ticketId}]`;
  return s;
}

// RFC 2047 for a header value with non-ASCII characters.
const encodeHeader = (value) => (/^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`);
const formatAddress = (name, address) => (name ? `${encodeHeader(`"${name.replace(/"/g, '')}"`)} <${address}>` : address);

const quote = (text) => text.split('\n').map(line => `> ${line}`).join('\n');

// The reply as a raw MIME message for SES SendRawEmail: plain text, the
// customer's last message quoted underneath, threaded with In-Reply-To and
// References so it lands in their existing conversation.
export function buildReplyMime({ to, toName, subject, body, inReplyTo, references = [], bcc, quoted, date = new Date() }) {
  let text = body.replace(/\r\n?/g, '\n').trimEnd();
  if (quoted?.bodyText) {
    const when = quoted.date ? new Date(quoted.date).toUTCString() : 'earlier';
    text += `\n\nOn ${when}, ${quoted.fromName || quoted.fromAddress} wrote:\n${quote(quoted.bodyText)}`;
  }
  const refs = [...new Set([...references, inReplyTo].filter(Boolean))].slice(-20);
  const messageId = `<${crypto.randomUUID()}@${OWN_DOMAIN}>`;
  const headers = [
    `From: ${formatAddress('IndieTix Support', SUPPORT_ADDRESS)}`,
    `To: ${formatAddress(toName, to)}`,
    `Reply-To: ${SUPPORT_ADDRESS}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: ${messageId}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(refs.length ? [`References: ${refs.join(' ')}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64'
  ];
  const encoded = Buffer.from(text + '\n', 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
  const destinations = [to, ...(bcc ? [bcc] : [])];
  // If SES replaces the Message-ID, the [T-n] subject token still threads replies.
  return { raw: `${headers.join('\r\n')}\r\n\r\n${encoded}\r\n`, destinations, messageId };
}

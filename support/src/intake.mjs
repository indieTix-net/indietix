// Lambda for support@indietix.net. Two ways in:
//  - an SES receipt rule (S3 action, then this Lambda): file the email under
//    a ticket and draft a reply, unless it's spam or automated mail;
//  - { "action": "draft", "ticketId": n } from the inbox: redraft the reply
//    to that ticket's latest email.
// Never throws for a single bad email: SES retries a failed Lambda, and a
// stored message is deduplicated by its Message-ID anyway.

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import Anthropic from '@anthropic-ai/sdk';
import { createDataApiQuery } from './db.mjs';
import { parseEmail, skipReason, ticketNumberFromSubject } from './mail.mjs';
import { findTicketForEmail, createTicket, addMessage, saveDraft, getTicket, getMessages, setStatus, deleteExpired } from './store.mjs';
import { generateDraft } from './draft.mjs';

const NEW_TICKET_STATUS = { spam: 'spam', virus: 'spam', auto_reply: 'closed', bulk: 'closed', automated_sender: 'closed', own_address: 'closed', no_sender: 'closed' };

export async function draftTicket(deps, ticketId) {
  const ticket = await getTicket(deps.query, ticketId);
  if (!ticket) return { error: 'ticket not found' };
  const messages = await getMessages(deps.query, ticketId);
  const latest = [...messages].reverse().find(m => m.Direction === 'in');
  if (!latest) return { error: 'no email to reply to' };
  const result = await generateDraft(await deps.anthropic(), ticket, messages, deps.knowledge);
  if (result.declined) {
    console.warn(`Draft declined for T-${ticketId} (model ${result.model})`);
    return { declined: true };
  }
  await saveDraft(deps.query, latest.ID, result);
  console.log(`Drafted T-${ticketId} message ${latest.ID} with ${result.model}`, JSON.stringify(result.usage || {}));
  return { draft: result.draft, model: result.model, messageId: latest.ID };
}

export async function receiveEmail(deps, { raw, s3Key, receipt }) {
  const email = await parseEmail(raw);
  const skipped = skipReason(email, receipt);
  let ticket = await findTicketForEmail(deps.query, {
    references: email.references, ticketNumber: ticketNumberFromSubject(email.subject), fromAddress: email.fromAddress
  });
  const isNew = !ticket;
  if (isNew) {
    ticket = await createTicket(deps.query, { subject: email.subject, customerEmail: email.fromAddress || 'unknown', customerName: email.fromName });
  }
  const stored = await addMessage(deps.query, ticket.ID, { ...email, direction: 'in', s3Key, skipped });
  if (!stored) {
    console.log(`Already have ${email.messageId}; nothing to do`);
    return { duplicate: true, ticketId: ticket.ID };
  }
  if (skipped) {
    if (isNew) await setStatus(deps.query, ticket.ID, NEW_TICKET_STATUS[skipped] || 'closed');
    else if (skipped === 'spam' || skipped === 'virus') await setStatus(deps.query, ticket.ID, 'spam');
    console.log(`T-${ticket.ID}: stored ${email.messageId}, no draft (${skipped})`);
    return { ticketId: ticket.ID, skipped };
  }
  let drafted = false;
  try {
    drafted = Boolean((await draftTicket(deps, ticket.ID)).draft);
  } catch (error) {
    // The email is stored; the inbox's Regenerate button retries the draft.
    console.error(`ERROR drafting T-${ticket.ID}:`, error?.status || '', error?.message);
  }
  if (deps.notify) {
    try {
      await deps.notify({ ticket, email, drafted });
    } catch (error) {
      console.error(`ERROR sending the new-ticket notice for T-${ticket.ID}:`, error.message);
    }
  }
  return { ticketId: ticket.ID, isNew, drafted };
}

// ---- AWS wiring ----

let cached;
function defaultDeps() {
  if (cached) return cached;
  const region = process.env.AWS_REGION || 'us-east-2';
  const s3 = new S3Client({ region });
  const secrets = new SecretsManagerClient({ region });
  const ses = new SESClient({ region });
  let anthropic;
  cached = {
    query: createDataApiQuery({
      resourceArn: process.env.DB_CLUSTER_ARN, secretArn: process.env.DB_SECRET_ARN,
      database: process.env.DB_NAME || 'indietix', region
    }),
    async anthropic() {
      if (!anthropic) {
        const secret = await secrets.send(new GetSecretValueCommand({ SecretId: process.env.ANTHROPIC_SECRET_ID }));
        anthropic = new Anthropic({ apiKey: JSON.parse(secret.SecretString).api_key });
      }
      return anthropic;
    },
    async getRaw(key) {
      const object = await s3.send(new GetObjectCommand({ Bucket: process.env.INBOUND_BUCKET, Key: key }));
      return Buffer.from(await object.Body.transformToByteArray());
    },
    notify: process.env.NOTIFY_EMAIL ? async ({ ticket, email, drafted }) => {
      await ses.send(new SendEmailCommand({
        Source: process.env.NOTIFY_FROM || 'indietix@indietix.net',
        Destination: { ToAddresses: [process.env.NOTIFY_EMAIL] },
        Message: {
          Subject: { Data: `[support T-${ticket.ID}] ${email.subject || '(no subject)'}`.slice(0, 200) },
          Body: { Text: { Data: `New support email from ${email.fromName ? `${email.fromName} <${email.fromAddress}>` : email.fromAddress}.\n${drafted ? 'A draft reply is ready.' : 'No draft yet; use Regenerate in the inbox.'}\n\nOpen the inbox: ./support.sh (in infrastructure/).` } }
        }
      }));
    } : null
  };
  return cached;
}

// Lambda passes (event, context, callback), so the entry point takes no deps of its own;
// tests call handleEvent with fakes.
export const handler = (event) => handleEvent(event, defaultDeps());

export async function handleEvent(event, deps) {
  if (event?.action === 'draft') {
    return draftTicket(deps, Number(event.ticketId));
  }
  const record = event?.Records?.[0];
  if (record?.eventSource !== 'aws:ses') {
    console.error('Unexpected event', JSON.stringify(event).slice(0, 500));
    return { error: 'unexpected event' };
  }
  const { mail, receipt } = record.ses;
  console.log('Support email received', JSON.stringify({ messageId: mail.messageId, from: mail.source, spam: receipt?.spamVerdict?.status, virus: receipt?.virusVerdict?.status }));
  const s3Key = `${process.env.INBOUND_PREFIX || 'support/'}${mail.messageId}`;
  let result;
  try {
    result = await receiveEmail(deps, { raw: await deps.getRaw(s3Key), s3Key, receipt });
  } catch (error) {
    console.error(`ERROR processing support email ${mail.messageId}:`, error);
    throw error; // nothing was stored; let SES retry
  }
  try {
    const removed = await deleteExpired(deps.query);
    if (removed) console.log(`Deleted ${removed} support ticket(s) past the retention period`);
  } catch (error) {
    console.error('ERROR deleting expired support tickets:', error.message);
  }
  return result;
}

// Shared test fixtures: raw emails and a fake Anthropic client.

export function rawEmail({ from = 'Sam Lee <sam@venue.example>', to = 'support@indietix.net', subject = 'Scanner question', body = 'Hi, the scanner camera will not start on my iPad.', messageId = '<abc123@venue.example>', inReplyTo, references, headers = {}, attachment } = {}) {
  const lines = [
    `From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Message-ID: ${messageId}`,
    'Date: Sat, 07 Nov 2026 15:04:05 +0000', 'MIME-Version: 1.0',
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references ? [`References: ${references}`] : []),
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)
  ];
  if (!attachment) return [...lines, 'Content-Type: text/plain; charset=utf-8', '', body, ''].join('\r\n');
  return [...lines,
    'Content-Type: multipart/mixed; boundary="b1"', '', '--b1', 'Content-Type: text/plain; charset=utf-8', '', body, '',
    '--b1', `Content-Type: image/png; name="${attachment}"`, `Content-Disposition: attachment; filename="${attachment}"`,
    'Content-Transfer-Encoding: base64', '', 'iVBORw0KGgo=', '--b1--', ''].join('\r\n');
}

export function fakeAnthropic({ text = 'Hi Sam,\n\nTry reloading the page.\n\nIndieTix Support', stopReason = 'end_turn', fail } = {}) {
  const calls = [];
  return {
    calls,
    beta: { messages: { create: async (request) => {
      calls.push(request);
      if (fail) throw Object.assign(new Error(fail), { status: 529 });
      return { stop_reason: stopReason, model: request.model, content: stopReason === 'refusal' ? [] : [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } };
    } } }
  };
}

// Minimal OpenAI-compatible streaming server used by the end-to-end tests.
// POST /v1/chat/completions streams a canned Kurisu reply (server.reply overrides
// it); "Bearer bad" -> 401.
import http from 'node:http';

const REPLY = process.env.FAKE_REPLY ??
  "[SMILE] Oh, you're finally here. I was starting to think you'd forgotten about me. [BLUSH] N-not that I was waiting or anything! Anyway, what do you want to talk about? [SAVE_FACT: The user's name is Julien]";

export function startFakeServer(port = 8787) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.end();
    let body = '';
    for await (const chunk of req) body += chunk;
    server.lastRequest = { headers: req.headers, body: JSON.parse(body || '{}') };
    if (server.failNext > 0) {
      server.failNext--;
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { code: 503, message: 'The model is overloaded. Please try again later.' } }));
    }
    if (req.headers.authorization === 'Bearer bad') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
    }
    const tokens = (server.reply ?? REPLY).match(/.{1,6}/gs);
    if (req.url.startsWith('/v1/messages')) {
      // Anthropic Messages API event stream.
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
      send('message_start', { message: { id: 'msg_test', type: 'message', role: 'assistant', model: server.lastRequest.body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } });
      send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      for (const tok of tokens) {
        send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: tok } });
        await new Promise((r) => setTimeout(r, 10));
      }
      send('content_block_stop', { index: 0 });
      send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 40 } });
      send('message_stop', {});
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const tok of tokens) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: tok } }] })}\n\n`);
      await new Promise((r) => setTimeout(r, 15));
    }
    res.end('data: [DONE]\n\n');
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startFakeServer().then(() => console.log('fake LLM on :8787'));
}

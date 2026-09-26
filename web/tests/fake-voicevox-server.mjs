// Minimal VOICEVOX engine used by the end-to-end tests: /speakers, /audio_query
// and /synthesis (a short tone whose length follows the text, as a 24 kHz WAV).
import http from 'node:http';

const SPEAKERS = [
  { name: '四国めたん', speaker_uuid: 'a', styles: [{ name: 'ノーマル', id: 2, type: 'talk' }, { name: 'ツンツン', id: 6, type: 'talk' }] },
  { name: '冥鳴ひまり', speaker_uuid: 'b', styles: [{ name: 'ノーマル', id: 14, type: 'talk' }, { name: 'ハミング', id: 3001, type: 'frame_decode' }] },
];

function wav(seconds) {
  const rate = 24000;
  const n = Math.round(rate * seconds);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const envelope = Math.abs(Math.sin((Math.PI * i) / (rate * 0.25)));
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * envelope * 12000), 44 + i * 2);
  }
  return buf;
}

export function startFakeVoicevox(port = 50021) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') return res.end();
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://x');
    server.requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), body });
    if (url.pathname === '/speakers') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(SPEAKERS));
    }
    if (url.pathname === '/audio_query') {
      const text = url.searchParams.get('text') ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ accent_phrases: [], speedScale: 1, pitchScale: 0, intonationScale: 1, volumeScale: 1, prePhonemeLength: 0.1, postPhonemeLength: 0.1, outputSamplingRate: 24000, outputStereo: false, kana: text }));
    }
    if (url.pathname === '/synthesis') {
      const q = JSON.parse(body);
      await new Promise((r) => setTimeout(r, 150));
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      return res.end(wav(Math.min(3, 0.3 + q.kana.length * 0.08)));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"detail":"Not Found"}');
  });
  server.requests = [];
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

// VOICEVOX (https://voicevox.hiroshiba.jp/): free Japanese text-to-speech engine
// running on the user's PC, reached like Ollama over the LAN or Tailscale.
// Kurisu's lines are synthesised in Japanese and played through Web Audio, whose
// loudness also drives the lip sync.

import { audio } from '../audio/se';
import { appFetch } from '../native/bridge';
import { settings } from '../settings';

export const VOICEVOX_PORT = 50021;

export interface VoicevoxStyle {
  id: number;
  speaker: string;
  style: string;
}

/** Engine address: the setting, or the Ollama computer on port 50021. */
export function voicevoxBase(host = settings.get().voicevoxHost, ollamaHost = settings.get().ollamaHost): string {
  let base = host.trim();
  if (!base) {
    try {
      const u = new URL(ollamaHost.trim());
      base = `${u.protocol}//${u.hostname}:${VOICEVOX_PORT}`;
    } catch {
      base = `http://localhost:${VOICEVOX_PORT}`;
    }
  }
  if (!/^https?:\/\//i.test(base)) base = `http://${base}`;
  try {
    // Only the engine's origin: a pasted test URL such as http://pc:50021/version still works.
    return new URL(base).origin;
  } catch {
    return base.replace(/\/+$/, '');
  }
}

async function check(res: Response, what: string): Promise<Response> {
  if (res.ok) return res;
  let detail = '';
  try {
    detail = (await res.text()).slice(0, 200);
  } catch {
    // ignore
  }
  throw new Error(`VOICEVOX ${what}: HTTP ${res.status} ${detail}`.trim());
}

async function request(url: string, init: RequestInit, what: string): Promise<Response> {
  let res: Response;
  try {
    res = await appFetch(url, init);
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    throw new Error(`VOICEVOX ${what}: ${(e as Error)?.message || e}`);
  }
  return check(res, what);
}

/** Talk styles of every installed character, e.g. 四国めたん（ツンツン）. */
export async function fetchStyles(base: string, signal?: AbortSignal): Promise<VoicevoxStyle[]> {
  const res = await request(`${base}/speakers`, { signal }, 'speakers');
  const list = (await res.json()) as { name: string; styles: { name: string; id: number; type?: string }[] }[];
  return list.flatMap((sp) =>
    sp.styles
      .filter((st) => !st.type || st.type === 'talk' || st.type === 'streaming_talk')
      .map((st) => ({ id: st.id, speaker: sp.name, style: st.name })),
  );
}

export interface SynthOptions {
  base: string;
  styleId: number;
  /** 1 = normal speed (the app's speech rate setting). */
  rate: number;
  /** 1 = normal pitch (the app's pitch setting). */
  pitch: number;
  signal?: AbortSignal;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Japanese text -> WAV bytes (/audio_query then /synthesis). */
export async function synthesize(text: string, o: SynthOptions): Promise<ArrayBuffer> {
  const q = await request(
    `${o.base}/audio_query?speaker=${o.styleId}&text=${encodeURIComponent(text)}`,
    { method: 'POST', signal: o.signal },
    'audio_query',
  );
  const query = await q.json();
  query.speedScale = clamp(o.rate, 0.5, 2);
  query.pitchScale = clamp((o.pitch - 1) * 0.15, -0.15, 0.15);
  const res = await request(
    `${o.base}/synthesis?speaker=${o.styleId}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'audio/wav' }, body: JSON.stringify(query), signal: o.signal },
    'synthesis',
  );
  return res.arrayBuffer();
}

export function currentSynthOptions(): Omit<SynthOptions, 'signal'> {
  const s = settings.get();
  return { base: voicevoxBase(), styleId: s.voicevoxStyle, rate: s.ttsRate, pitch: s.ttsPitch };
}

// ─── Playback ───

/** A line whose synthesis has started; played later, in display order. */
export interface VoiceLine {
  text: string;
  audio: Promise<AudioBuffer | null>;
}

/**
 * Plays synthesised lines one at a time. Lines are synthesised as soon as they are
 * known (while the text is still streaming) so the voice starts with its page.
 */
export class VoicePlayer {
  /** A line is waiting for its audio or playing (auto mode waits for it). */
  busy = false;
  /** Called with the technical message when a line cannot be synthesised. */
  onError: (message: string) => void = () => {};

  private source: AudioBufferSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private samples = new Float32Array(1024);
  private token = 0;
  private queue: VoiceLine[] = [];
  private inflight = new Set<AbortController>();
  private level = 0;

  prepare(text: string, opts = currentSynthOptions(), onError = this.onError): VoiceLine {
    const ctrl = new AbortController();
    this.inflight.add(ctrl);
    const audioBuf = synthesize(text, { ...opts, signal: ctrl.signal })
      .then((wav) => {
        const ac = audio();
        if (!ac) throw new Error('Web Audio unavailable');
        return ac.decodeAudioData(wav);
      })
      .catch((e: Error) => {
        if (e?.name !== 'AbortError') onError(e?.message || String(e));
        return null;
      })
      .finally(() => this.inflight.delete(ctrl));
    return { text, audio: audioBuf };
  }

  /** Interrupts the current line (as a new page does in a visual novel) and plays this one. */
  play(line: VoiceLine): void {
    this.queue = [line];
    this.token++;
    this.stopSource();
    void this.next(this.token);
  }

  /** Plays after the lines already queued. */
  enqueue(line: VoiceLine): void {
    this.queue.push(line);
    if (!this.busy) void this.next(this.token);
  }

  /** Silence, and drop every pending synthesis. */
  stop(): void {
    this.token++;
    this.queue = [];
    this.stopSource();
    for (const c of this.inflight) c.abort();
    this.inflight.clear();
    this.busy = false;
  }

  get playing(): boolean {
    return this.source !== null;
  }

  /** Mouth opening in [0, 1] from the loudness of the voice being played. */
  mouthLevel(): number {
    if (!this.analyser || !this.source) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const v of this.samples) sum += v * v;
    const rms = Math.sqrt(sum / this.samples.length);
    const target = Math.min(1, Math.max(0, (rms - 0.01) * 7));
    this.level += (target - this.level) * 0.5;
    return this.level;
  }

  private stopSource(): void {
    if (!this.source) return;
    this.source.onended = null;
    try {
      this.source.stop();
    } catch {
      // already stopped
    }
    this.source.disconnect();
    this.source = null;
  }

  private async next(token: number): Promise<void> {
    const line = this.queue.shift();
    if (!line) {
      this.busy = false;
      return;
    }
    this.busy = true;
    const buf = await line.audio;
    if (token !== this.token) return;
    const ac = audio();
    if (!buf || !ac) {
      void this.next(token);
      return;
    }
    const s = settings.get();
    const gain = ac.createGain();
    gain.gain.value = s.masterVol * s.voiceVol;
    this.analyser ??= ac.createAnalyser();
    this.analyser.fftSize = 1024;
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.connect(gain).connect(this.analyser).connect(ac.destination);
    src.onended = () => {
      if (this.source !== src) return;
      this.source = null;
      src.disconnect();
      gain.disconnect();
      if (token === this.token) void this.next(token);
    };
    this.source = src;
    src.start();
  }
}

export const voice = new VoicePlayer();

// Short synthesized UI sound effects (the original has SE volume settings but ships
// no audio files). Respects the master and SE volume settings.

import { settings } from '../settings';

type SeKind = 'select' | 'open' | 'close' | 'confirm' | 'cancel' | 'send' | 'denied' | 'boot';

let ctx: AudioContext | null = null;

/** Shared Web Audio context (sound effects and the VOICEVOX voice). */
export function audio(): AudioContext | null {
  if (!ctx) {
    try {
      ctx = new AudioContext();
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function tone(ac: AudioContext, freq: number, start: number, dur: number, gain: number, type: OscillatorType = 'sine') {
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, ac.currentTime + start);
  g.gain.setValueAtTime(0, ac.currentTime + start);
  g.gain.linearRampToValueAtTime(gain, ac.currentTime + start + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + start + dur);
  osc.connect(g).connect(ac.destination);
  osc.start(ac.currentTime + start);
  osc.stop(ac.currentTime + start + dur + 0.02);
}

export function se(kind: SeKind): void {
  const s = settings.get();
  const vol = s.masterVol * s.seVol * 0.12;
  if (vol <= 0.001) return;
  const ac = audio();
  if (!ac) return;
  switch (kind) {
    case 'select': tone(ac, 1320, 0, 0.05, vol, 'triangle'); break;
    case 'open': tone(ac, 660, 0, 0.07, vol, 'triangle'); tone(ac, 990, 0.05, 0.09, vol, 'triangle'); break;
    case 'close': tone(ac, 990, 0, 0.06, vol, 'triangle'); tone(ac, 660, 0.05, 0.08, vol, 'triangle'); break;
    case 'confirm': tone(ac, 880, 0, 0.06, vol, 'sine'); tone(ac, 1320, 0.06, 0.12, vol, 'sine'); break;
    case 'cancel': tone(ac, 440, 0, 0.1, vol, 'sine'); break;
    case 'send': tone(ac, 1046, 0, 0.05, vol, 'sine'); tone(ac, 1568, 0.04, 0.08, vol * 0.8, 'sine'); break;
    case 'denied': tone(ac, 220, 0, 0.18, vol * 1.3, 'square'); tone(ac, 196, 0.2, 0.22, vol * 1.3, 'square'); break;
    case 'boot': tone(ac, 523, 0, 0.12, vol, 'sine'); tone(ac, 784, 0.12, 0.14, vol, 'sine'); tone(ac, 1046, 0.26, 0.3, vol, 'sine'); break;
  }
}

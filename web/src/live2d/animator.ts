// Procedural animation of Amadeus Kurisu, ported from AmadeusChatController.LateUpdate()
// of the original RealAmadeus (Unity). Emotions drive face/body parameters directly,
// with a spring "burst" on each change, per-emotion idle drift, blinking, gaze,
// lip sync, breathing, falling asleep, waking up startled and the sneeze easter egg.

import { perlin } from './noise';
import type { ParamSink } from './stage';

export type EmotionTag =
  | 'NORMAL' | 'SMILE' | 'ANGRY' | 'SAD' | 'SURPRISED' | 'BLUSH' | 'WINK'
  | 'DISGUST' | 'SMUG' | 'THINKING' | 'PANIC' | 'SLEEPING' | 'SNEEZE';

export const EMOTION_TAGS: EmotionTag[] = [
  'NORMAL', 'SMILE', 'ANGRY', 'SAD', 'SURPRISED', 'BLUSH', 'WINK', 'DISGUST', 'SMUG', 'THINKING', 'PANIC',
];

interface EmotionTarget {
  browY: number; browForm: number; browAngle: number;
  eyeOpen: number; eyeSmile: number;
  mouthForm: number;
  bodyAngleX: number; bodyAngleY: number; bodyAngleZ: number;
  headAngleX: number; headAngleY: number; headAngleZ: number;
  cheek: number;
  isWink: boolean;
}

interface MotionBurst {
  bodyX: number; bodyY: number; bodyZ: number;
  headX: number; headY: number; headZ: number;
  duration: number; intensity: number;
}

/** State the animator needs from the chat/UI layer each frame. */
export interface AnimatorHost {
  /** Kurisu is "speaking": text is being typed out or the TTS voice is playing. */
  isMouthMoving(): boolean;
  /** Mouth opening driven by the actual voice audio, or null to use isMouthMoving(). */
  mouthLevel(): number | null;
  /** No reply in progress and the input box is ready (sneeze easter egg allowed). */
  isIdleForSneeze(): boolean;
  /** Normalised gaze target in [-0.7, 0.7], or null when gaze tracking is off/inactive. */
  gazeTarget(): { x: number; y: number } | null;
  /** Current speaking state (deeper breathing while speaking). */
  isSpeaking(): boolean;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * Math.min(1, Math.max(0, t));
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function emotionTarget(tag: string): EmotionTarget {
  const e: EmotionTarget = {
    browY: 0, browForm: 0, browAngle: 0, eyeOpen: 0, eyeSmile: 0, mouthForm: 0,
    bodyAngleX: 0, bodyAngleY: 0, bodyAngleZ: 0, headAngleX: 0, headAngleY: 0, headAngleZ: 0,
    cheek: 0, isWink: false,
  };
  const set = (v: Partial<EmotionTarget>) => Object.assign(e, v);
  switch (tag) {
    case 'NORMAL':
      set({ browY: 0, browForm: 0.5, browAngle: 0, eyeOpen: 1, eyeSmile: 0, mouthForm: 0 });
      break;
    case 'SMILE':
      set({ browY: 0.4, browForm: 0.8, browAngle: 0.2, eyeOpen: 0.6, eyeSmile: 1, mouthForm: 1,
        bodyAngleX: 3, bodyAngleY: 0, bodyAngleZ: -2, headAngleX: 5, headAngleY: 3, headAngleZ: -3, cheek: 0.3 });
      break;
    case 'ANGRY':
      set({ browY: -0.6, browForm: -0.8, browAngle: -0.8, eyeOpen: 0.5, eyeSmile: 0, mouthForm: -0.8,
        bodyAngleX: -4, headAngleX: -5, headAngleY: -5 });
      break;
    case 'SAD':
      set({ browY: -0.5, browForm: -0.6, browAngle: 0.6, eyeOpen: 0.4, mouthForm: -0.5,
        bodyAngleX: -3, bodyAngleY: -3, bodyAngleZ: -3, headAngleX: -8, headAngleY: -7, headAngleZ: -5 });
      break;
    case 'SURPRISED':
      set({ browY: 0.8, browForm: 0.5, browAngle: 0, eyeOpen: 1.25, mouthForm: -0.4,
        bodyAngleX: -2, bodyAngleY: 5, bodyAngleZ: 2, headAngleX: 2, headAngleY: 8 });
      break;
    case 'BLUSH':
      set({ browY: 0.2, browForm: 0.4, browAngle: 0.3, eyeOpen: 0.6, eyeSmile: 0.7, mouthForm: 0.3,
        bodyAngleX: 8, bodyAngleY: -3, bodyAngleZ: -3, headAngleX: 8, headAngleY: -8, headAngleZ: -7, cheek: 1 });
      break;
    case 'WINK':
      set({ browY: 0.5, browForm: 0.8, browAngle: 0.2, eyeOpen: 1, eyeSmile: 0.7, mouthForm: 0.5,
        bodyAngleX: 2, bodyAngleZ: -5, headAngleX: 5, headAngleY: 2, headAngleZ: -5, isWink: true });
      break;
    case 'DISGUST':
      set({ browY: -0.3, browForm: -0.9, browAngle: -0.5, eyeOpen: 0.4, mouthForm: -0.9,
        bodyAngleX: 5, bodyAngleY: 4, bodyAngleZ: 2, headAngleX: 5, headAngleY: -4, headAngleZ: 3 });
      break;
    case 'SMUG':
      set({ browY: 0.3, browForm: 0.7, browAngle: 0.4, eyeOpen: 0.6, eyeSmile: 0.8, mouthForm: 0.6,
        bodyAngleX: 4, bodyAngleZ: -2, headAngleX: 10, headAngleY: 5, headAngleZ: -2 });
      break;
    case 'THINKING':
      set({ browY: -0.2, browForm: -0.3, browAngle: 0.2, eyeOpen: 0.8, mouthForm: -0.2,
        bodyAngleX: -2, bodyAngleY: 5, bodyAngleZ: 5, headAngleX: 5, headAngleY: -8, headAngleZ: 5 });
      break;
    case 'PANIC':
      set({ browY: 0.6, browForm: -0.5, browAngle: -0.3, eyeOpen: 1.2, mouthForm: -0.5,
        bodyAngleX: -3, headAngleX: -2, cheek: 0.6 });
      break;
    case 'SLEEPING':
      set({ browY: -0.3, browForm: 0.2, browAngle: -0.2, eyeOpen: 0, eyeSmile: 0, mouthForm: -0.1,
        bodyAngleX: -1, bodyAngleY: -2, bodyAngleZ: -2, headAngleX: -12, headAngleY: -10, headAngleZ: -8 });
      break;
  }
  return e;
}

function motionBurst(tag: string): MotionBurst {
  const b: MotionBurst = { bodyX: 0, bodyY: 0, bodyZ: 0, headX: 0, headY: 0, headZ: 0, duration: 0.6, intensity: 1 };
  const set = (v: Partial<MotionBurst>) => Object.assign(b, v);
  switch (tag) {
    case 'NORMAL': set({ bodyY: 1, headY: 1, duration: 0.4, intensity: 0.5 }); break;
    case 'SMILE': set({ bodyX: 4, bodyY: 2, bodyZ: -2, headX: 5, headY: 3, headZ: -3, duration: 0.5, intensity: 0.8 }); break;
    case 'ANGRY': set({ bodyX: -5, bodyY: -3, headX: -5, headY: -5, duration: 0.5, intensity: 1.2 }); break;
    case 'SAD': set({ bodyX: -2, bodyY: -3, bodyZ: -2, headX: -3, headY: -4, headZ: -2, duration: 0.8, intensity: 0.7 }); break;
    case 'SURPRISED': set({ bodyX: -2, bodyY: 5, bodyZ: 2, headY: 8, duration: 0.4, intensity: 1.5 }); break;
    case 'BLUSH': set({ bodyX: 8, bodyY: -2, bodyZ: -3, headX: 12, headY: -3, headZ: -5, duration: 0.6, intensity: 1 }); break;
    case 'WINK': set({ bodyX: 5, bodyY: 2, bodyZ: -2, headX: 6, headY: 3, headZ: -4, duration: 0.4, intensity: 0.9 }); break;
    case 'DISGUST': set({ bodyX: 5, bodyY: 4, bodyZ: 2, headX: 7, headY: -3, headZ: 3, duration: 0.5, intensity: 1.1 }); break;
    case 'SMUG': set({ bodyX: 2, bodyY: 2, bodyZ: -1, headX: 5, headY: 3, headZ: -1, duration: 0.7, intensity: 0.6 }); break;
    case 'THINKING': set({ headX: 2, headY: -3, headZ: 1, duration: 0.8, intensity: 0.3 }); break;
    case 'PANIC': set({ duration: 0.2, intensity: 2 }); break;
    case 'SLEEPING': set({ bodyX: -1, bodyY: -2, bodyZ: -1, headX: -2, headY: -3, headZ: -2, duration: 4.5, intensity: 0.3 }); break;
    case 'SNEEZE': set({ duration: 2.2, intensity: 1 }); break;
  }
  return b;
}

/** Layered noise: slow drift + medium sway + micro jitter, each with its own seed. */
function drift(p: number, speed: number, seed: number, amplitude: number): number {
  const slow = (perlin(p * speed * 0.3, seed) - 0.5) * 2;
  const medium = (perlin(p * speed * 0.8, seed + 50) - 0.5) * 2;
  const micro = (perlin(p * speed * 2.5, seed + 100) - 0.5) * 2;
  return (slow * 0.5 + medium * 0.35 + micro * 0.15) * amplitude;
}

function idleMotion(tag: string, phase: number): [number, number, number, number, number, number] {
  let bx = 0, by = 0, bz = 0, hx = 0, hy = 0, hz = 0;
  switch (tag) {
    case 'NORMAL':
      bx = drift(phase, 0.6, 0, 1.8);
      by = drift(phase, 0.4, 10, 0.8) + Math.sin(phase * 0.8) * 0.3;
      bz = drift(phase, 0.35, 20, 0.6);
      hx = drift(phase, 0.5, 30, 3);
      hy = drift(phase, 0.4, 40, 2);
      hz = drift(phase, 0.3, 50, 1);
      break;
    case 'SMILE':
      bx = drift(phase, 1.2, 5, 3); by = drift(phase, 1, 15, 1.5); bz = drift(phase, 0.7, 25, 1.5);
      hx = drift(phase, 1, 35, 4); hy = drift(phase, 0.8, 45, 2.5); hz = drift(phase, 0.9, 55, 2);
      break;
    case 'ANGRY': {
      const tension = (perlin(phase * 3, 7) - 0.5) * 2;
      bx = drift(phase, 1.5, 8, 2.5) + tension * 1.5; by = drift(phase, 0.5, 18, 0.8); bz = drift(phase, 2, 28, 1.2);
      hx = drift(phase, 1.8, 38, 3) + tension; hy = drift(phase, 1.2, 48, 2); hz = drift(phase, 0.8, 58, 1);
      break;
    }
    case 'SAD':
      bx = drift(phase, 0.4, 3, 2.5); by = drift(phase, 0.3, 13, 1.5); bz = drift(phase, 0.35, 23, 1.8);
      hx = drift(phase, 0.3, 33, 3.5); hy = drift(phase, 0.25, 43, 2.5); hz = drift(phase, 0.3, 53, 1.5);
      break;
    case 'SURPRISED':
      bx = drift(phase, 1.8, 6, 3); by = drift(phase, 1.5, 16, 1.5) + Math.abs(Math.sin(phase * 1.5)) * 0.8;
      bz = drift(phase, 1, 26, 1.5); hx = drift(phase, 2, 36, 5); hy = drift(phase, 1.8, 46, 4.5); hz = drift(phase, 1, 56, 1.5);
      break;
    case 'BLUSH': {
      const fidget = (perlin(phase * 4, 99) - 0.5) * 1.5;
      bx = drift(phase, 0.8, 9, 3) + 1; by = drift(phase, 0.6, 19, 1); bz = drift(phase, 0.9, 29, 2);
      hx = drift(phase, 0.6, 39, 4) + 2 + fidget; hy = drift(phase, 0.5, 49, 3); hz = drift(phase, 0.7, 59, 2.5);
      break;
    }
    case 'WINK':
      bx = drift(phase, 1.3, 4, 3.5); by = drift(phase, 0.8, 14, 1.2); bz = drift(phase, 0.9, 24, 2);
      hx = drift(phase, 1, 34, 4.5); hy = drift(phase, 0.7, 44, 2.5); hz = drift(phase, 1.1, 54, 2.5);
      break;
    case 'DISGUST':
      bx = drift(phase, 0.7, 2, 2.5) + 1; by = drift(phase, 0.9, 12, 1.5); bz = drift(phase, 0.5, 22, 1);
      hx = drift(phase, 0.8, 32, 3.5) + 1.5; hy = drift(phase, 0.6, 42, 2.5); hz = drift(phase, 0.5, 52, 1.5);
      break;
    case 'SMUG':
      bx = drift(phase, 0.5, 4, 2); by = drift(phase, 0.4, 14, 1); bz = drift(phase, 0.4, 24, 1.5);
      hx = drift(phase, 0.6, 34, 3) + 3; hy = drift(phase, 0.5, 44, 2); hz = drift(phase, 0.5, 54, 1);
      break;
    case 'THINKING':
      bx = drift(phase, 0.2, 5, 1); by = drift(phase, 0.2, 15, 0.5); bz = drift(phase, 0.2, 25, 0.5);
      hx = drift(phase, 0.2, 35, 1); hy = drift(phase, 0.2, 45, 1); hz = drift(phase, 0.2, 55, 0.5);
      break;
    case 'PANIC': {
      const panic = (perlin(phase * 15, 999) - 0.5) * 4;
      bx = drift(phase, 2, 6, 2) + panic; by = drift(phase, 2, 16, 2); bz = drift(phase, 2, 26, 2);
      hx = drift(phase, 3, 36, 3) + panic; hy = panic * 1.5; hz = panic * 0.5;
      break;
    }
    case 'SLEEPING':
      bx = drift(phase * 0.3, 0.15, 0, 0.5);
      by = drift(phase * 0.3, 0.5, 10, 0.6) + Math.sin(phase * 0.8) * 0.6;
      bz = drift(phase * 0.3, 0.1, 20, 0.3);
      hx = drift(phase * 0.3, 0.2, 30, 1);
      hy = drift(phase * 0.3, 0.15, 40, 0.5) + Math.sin(phase * 0.8) * 0.3;
      hz = drift(phase * 0.3, 0.2, 50, 1.5);
      break;
  }
  return [bx, by, bz, hx, hy, hz];
}

type BlinkState = 'open' | 'closing' | 'opening';

export class KurisuAnimator {
  private current = emotionTarget('NORMAL');
  private target = emotionTarget('NORMAL');
  private readonly emotionLerpSpeed = 3;

  private burst = motionBurst('NORMAL');
  private burstTimer = 0;
  private burstProgress = 1;
  private burstTag = '';
  private emotionTag = 'NORMAL';

  private wakeUpTimer = 0;
  private wakeUpTargetTag = 'NORMAL';
  private wakeUpHeadX = 0;
  private wakeUpGazeX = 0;

  private sneezeTimer = 0;
  private sneezeEyeOpen = 1;
  private sneezeMouthOpen = 0;

  private idlePhase = 0;
  private time = 0;

  private blinkTimer = 0;
  private blinkInterval = 4;
  private readonly blinkDuration = 0.1;
  private blinkValue = 1;
  private blinkState: BlinkState = 'open';

  private gazeX = 0;
  private gazeY = 0;
  private readonly gazeSmoothSpeed = 5;
  private mouth = 0;

  /** Called whenever the displayed emotion changes (e.g. to update the input placeholder). */
  onEmotionChanged: ((tag: string) => void) | null = null;

  constructor(private host: AnimatorHost) {}

  get currentTag(): string {
    return this.emotionTag;
  }

  get isSleeping(): boolean {
    return this.emotionTag === 'SLEEPING';
  }

  processEmotion(rawTag: string): void {
    const tag = rawTag.trim().toUpperCase();
    if (tag === this.emotionTag && this.wakeUpTimer <= 0) return;

    const wakingUp = this.emotionTag === 'SLEEPING' && tag !== 'SLEEPING';
    const shown = wakingUp ? 'SURPRISED' : tag;
    if (wakingUp) {
      this.wakeUpTimer = 2.5;
      this.wakeUpTargetTag = tag;
    } else {
      this.wakeUpTimer = 0;
    }
    this.target = emotionTarget(shown);
    this.emotionTag = shown;
    this.burst = motionBurst(shown);
    this.burstTag = shown;
    this.burstTimer = 0;
    this.burstProgress = 0;
    this.idlePhase = 0;
    this.onEmotionChanged?.(this.emotionTag);
  }

  private updateBlink(dt: number): void {
    switch (this.blinkState) {
      case 'open':
        this.blinkTimer += dt;
        if (this.blinkTimer >= this.blinkInterval) {
          this.blinkTimer = 0;
          this.blinkState = 'closing';
          this.blinkInterval = 2.5 + Math.random() * 3.5;
        }
        this.blinkValue = 1;
        break;
      case 'closing':
        this.blinkTimer += dt;
        this.blinkValue = lerp(1, 0, this.blinkTimer / (this.blinkDuration * 0.5));
        if (this.blinkTimer >= this.blinkDuration * 0.5) {
          this.blinkTimer = 0;
          this.blinkState = 'opening';
        }
        break;
      case 'opening':
        this.blinkTimer += dt;
        this.blinkValue = lerp(0, 1, this.blinkTimer / (this.blinkDuration * 0.5));
        if (this.blinkTimer >= this.blinkDuration * 0.5) {
          this.blinkTimer = 0;
          this.blinkState = 'open';
        }
        break;
    }
  }

  update(dt: number, p: ParamSink): void {
    this.idlePhase += dt;
    this.time += dt;

    // Startled wake-up: blend from SURPRISED to the requested emotion, with a head shake.
    if (this.wakeUpTimer > 0) {
      this.wakeUpTimer -= dt;
      if (this.wakeUpTimer <= 0) {
        this.wakeUpTimer = 0;
        this.wakeUpHeadX = 0;
        this.wakeUpGazeX = 0;
        this.target = emotionTarget(this.wakeUpTargetTag);
        this.emotionTag = this.wakeUpTargetTag;
        this.onEmotionChanged?.(this.emotionTag);
      } else {
        const base = emotionTarget(this.wakeUpTargetTag);
        const surprised = emotionTarget('SURPRISED');
        const blend = this.wakeUpTimer < 1.7 ? clamp01(this.wakeUpTimer / 1.7) : 1;
        for (const k of Object.keys(base) as (keyof EmotionTarget)[]) {
          if (k === 'isWink') continue;
          (this.target[k] as number) = lerp(base[k] as number, surprised[k] as number, blend);
        }
        const elapsed = 2.5 - this.wakeUpTimer;
        if (elapsed >= 0.4 && elapsed < 1.4) {
          const wave = Math.sin((elapsed - 0.4) * 2 * Math.PI);
          this.wakeUpHeadX = wave * 15;
          this.wakeUpGazeX = wave * 0.7;
        } else {
          this.wakeUpHeadX = 0;
          this.wakeUpGazeX = 0;
        }
      }
    }

    // Sneeze easter egg: every 45 s of calm idling, 15 % chance.
    const idle = this.emotionTag === 'NORMAL' && this.burstProgress >= 1 && this.wakeUpTimer <= 0 && this.host.isIdleForSneeze();
    if (idle) {
      this.sneezeTimer += dt;
      if (this.sneezeTimer >= 45) {
        this.sneezeTimer = 0;
        if (Math.random() < 0.15) this.sneeze();
      }
    } else {
      this.sneezeTimer = 0;
    }

    // 1. Ease the base emotion parameters toward the target.
    const k = dt * this.emotionLerpSpeed;
    const c = this.current;
    const t = this.target;
    c.browY = lerp(c.browY, t.browY, k);
    c.browForm = lerp(c.browForm, t.browForm, k);
    c.browAngle = lerp(c.browAngle, t.browAngle, k);
    c.eyeOpen = lerp(c.eyeOpen, t.eyeOpen, k);
    c.eyeSmile = lerp(c.eyeSmile, t.eyeSmile, k);
    c.mouthForm = lerp(c.mouthForm, t.mouthForm, k);
    c.bodyAngleX = lerp(c.bodyAngleX, t.bodyAngleX, k);
    c.bodyAngleY = lerp(c.bodyAngleY, t.bodyAngleY, k);
    c.bodyAngleZ = lerp(c.bodyAngleZ, t.bodyAngleZ, k);
    c.headAngleX = lerp(c.headAngleX, t.headAngleX, k);
    c.headAngleY = lerp(c.headAngleY, t.headAngleY, k);
    c.headAngleZ = lerp(c.headAngleZ, t.headAngleZ, k);
    c.cheek = lerp(c.cheek, t.cheek, k);
    c.isWink = t.isWink;

    // 2. Motion burst.
    let bBX = 0, bBY = 0, bBZ = 0, bHX = 0, bHY = 0, bHZ = 0;
    if (this.burstProgress < 1) {
      this.burstTimer += dt;
      this.burstProgress = clamp01(this.burstTimer / Math.max(0.001, this.burst.duration));
      const t01 = this.burstProgress;
      if (this.emotionTag === 'SLEEPING') {
        // "nod, nod, nod"
        let nod: number;
        if (t01 < 0.33) nod = Math.sin((t01 / 0.33) * Math.PI) * -10;
        else if (t01 < 0.66) nod = Math.sin(((t01 - 0.33) / 0.33) * Math.PI) * -10;
        else nod = Math.sin(((t01 - 0.66) / 0.34) * Math.PI) * -18;
        bHY = nod;
        bBY = t01 * -1.5 + nod * 0.15;
      } else if (this.burstTag === 'SNEEZE') {
        if (t01 < 0.5) {
          const l = t01 / 0.5; // inhale, head back, eyes narrowing
          bHY = l * 12; bHX = l * -3; bBY = l * 1.5;
          this.sneezeEyeOpen = 1 - l * 0.9;
        } else if (t01 < 0.65) {
          const l = (t01 - 0.5) / 0.15; // the sneeze itself
          bHY = 12 - l * 32; bHX = -3 + l * 6; bBY = 1.5 - l * 5;
          this.sneezeEyeOpen = 0.1 * (1 - l);
          this.sneezeMouthOpen = l * 0.9;
        } else {
          const l = (t01 - 0.65) / 0.35; // bashful recovery
          bHY = -20 + l * 20; bHX = 3 - l * 3; bBY = -3.5 + l * 3.5;
          this.sneezeEyeOpen = l;
          this.sneezeMouthOpen = 0.9 * (1 - l);
        }
      } else {
        const spring = Math.sin(t01 * Math.PI * 2.5) * (1 - t01) * (1 - t01);
        const s = this.burst.intensity * spring;
        bBX = this.burst.bodyX * s; bBY = this.burst.bodyY * s; bBZ = this.burst.bodyZ * s;
        bHX = this.burst.headX * s; bHY = this.burst.headY * s; bHZ = this.burst.headZ * s;
      }
    }

    // 3. Emotion-specific idle motion.
    const [iBX, iBY, iBZ, iHX, iHY, iHZ] = idleMotion(this.emotionTag, this.idlePhase);

    // 4. Face.
    p.set('ParamBrowLY', c.browY);
    p.set('ParamBrowRY', c.browY);
    p.set('ParamBrowLForm', c.browForm);
    p.set('ParamBrowRForm', c.browForm);
    p.set('ParamBrowLAngle', c.browAngle);
    p.set('ParamBrowRAngle', c.browAngle);
    p.set('ParamEyeLSmile', c.eyeSmile);
    p.set('ParamEyeRSmile', c.eyeSmile);
    p.set('ParamMouthForm', c.mouthForm);
    p.set('ParamCheek', c.cheek);

    // 4.5 Blink and eye openness.
    this.updateBlink(dt);
    let baseEyeOpen = c.eyeOpen;
    const sneezing = this.burstProgress < 1 && this.burstTag === 'SNEEZE';
    if (this.emotionTag === 'SLEEPING' && this.burstProgress < 1) {
      const t01 = this.burstProgress;
      const l = t01 < 0.33 ? t01 / 0.33 : t01 < 0.66 ? (t01 - 0.33) / 0.33 : (t01 - 0.66) / 0.34;
      baseEyeOpen = 0.18 * Math.sin(l * Math.PI);
    } else if (sneezing) {
      baseEyeOpen = this.sneezeEyeOpen;
    }
    const eyeOpen = Math.max(0, baseEyeOpen * this.blinkValue);
    p.set('ParamEyeLOpen', eyeOpen);
    p.set('ParamEyeROpen', c.isWink ? 0 : eyeOpen);

    // 4.6 Gaze.
    const input = this.host.gazeTarget();
    const noGaze = this.wakeUpTimer > 0 || this.emotionTag === 'SLEEPING';
    const targetGX = this.wakeUpTimer > 0 ? this.wakeUpGazeX : noGaze || !input ? 0 : input.x;
    const targetGY = noGaze || !input ? 0 : input.y;
    this.gazeX = lerp(this.gazeX, targetGX, dt * this.gazeSmoothSpeed);
    this.gazeY = lerp(this.gazeY, targetGY, dt * this.gazeSmoothSpeed);
    p.set('ParamEyeBallX', this.gazeX);
    p.set('ParamEyeBallY', this.gazeY);

    // 5-6. Body and head = base + burst + idle + gaze.
    p.set('ParamBodyAngleX', c.bodyAngleX + bBX + iBX + this.gazeX * 5);
    p.set('ParamBodyAngleY', c.bodyAngleY + bBY + iBY + this.gazeY * 5);
    p.set('ParamBodyAngleZ', c.bodyAngleZ + bBZ + iBZ);
    p.set('ParamAngleX', c.headAngleX + bHX + iHX + this.gazeX * 25 + this.wakeUpHeadX);
    p.set('ParamAngleY', c.headAngleY + bHY + iHY + this.gazeY * 25);
    p.set('ParamAngleZ', c.headAngleZ + bHZ + iHZ);

    // 7. Lip sync.
    const voiceLevel = sneezing ? null : this.host.mouthLevel();
    if (sneezing) {
      this.mouth = clamp01(this.sneezeMouthOpen);
    } else if (voiceLevel !== null) {
      this.mouth = lerp(this.mouth, voiceLevel, dt * 25);
    } else if (this.host.isMouthMoving()) {
      const tt = this.time;
      this.mouth = clamp01(
        Math.abs(Math.sin(tt * 12)) * 0.5 + Math.abs(Math.sin(tt * 7.3)) * 0.3 + perlin(tt * 8, 5) * 0.2,
      );
    } else {
      this.mouth = lerp(this.mouth, 0, dt * 10);
    }
    p.set('ParamMouthOpenY', this.mouth);

    // 8. Breathing, deeper while speaking or startled.
    let depth = 0.5;
    if (this.host.isSpeaking()) depth = 0.7;
    if (this.emotionTag === 'PANIC' || this.emotionTag === 'SURPRISED') depth = 0.9;
    else if (this.emotionTag === 'SAD') depth = 0.4;
    const speed = this.emotionTag === 'SLEEPING' ? 0.8 : 1.2;
    p.set('ParamBreath', (Math.sin(this.time * speed) + 1) * depth);
  }

  sneeze(): void {
    this.emotionTag = 'NORMAL';
    this.burst = motionBurst('SNEEZE');
    this.burstTag = 'SNEEZE';
    this.burstTimer = 0;
    this.burstProgress = 0;
  }
}

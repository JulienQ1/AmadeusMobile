// Parsing of Kurisu's replies, ported from AmadeusChatController.cs:
// emotion tags ([SMILE] ...), memory commands ([SAVE_FACT: ...] / [SAVE_EVENT: {...}]),
// <think> blocks from reasoning models, and visual-novel page breaks.
// Mobile addition: [VOICE: ...] lines, the Japanese spoken by the VOICEVOX voice
// while the text is displayed in another language.

export const EMOTIONS = ['NORMAL', 'SMILE', 'ANGRY', 'SAD', 'SURPRISED', 'BLUSH', 'WINK', 'DISGUST', 'SMUG', 'THINKING', 'PANIC'];
const EMOTION_TAG_RE = /\[(NORMAL|SMILE|ANGRY|SAD|SURPRISED|BLUSH|WINK|DISGUST|SMUG|THINKING|PANIC)\]\s*/gi;

export const isEmotionTag = (tag: string) => EMOTIONS.includes(tag.trim().toUpperCase());

/** Index of the "]" closing a memory command, skipping brackets inside JSON strings/objects. */
export function findMemoryCommandEnd(text: string, payloadStart: number): number {
  let inString = false;
  let escaping = false;
  let braces = 0;
  let brackets = 0;
  for (let i = payloadStart; i < text.length; i++) {
    const ch = text[i];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (inString && ch === '\\') {
      escaping = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') braces++;
    else if (ch === '}' && braces > 0) braces--;
    else if (ch === '[') brackets++;
    else if (ch === ']') {
      if (braces === 0 && brackets === 0) return i;
      if (brackets > 0) brackets--;
    }
  }
  return -1;
}

export interface EpisodicCommand {
  summary: string;
  tags: string[];
}

export interface MemoryCommands {
  cleaned: string;
  facts: string[];
  events: EpisodicCommand[];
}

function splitTags(values: unknown[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    for (const part of String(v).split(/[,|、]/)) {
      const tag = part.trim();
      if (tag && !out.some((t) => t.toLowerCase() === tag.toLowerCase())) out.push(tag);
    }
  }
  return out;
}

function parseFact(payload: string): string {
  const p = payload.trim();
  if (p.startsWith('{') && p.endsWith('}')) {
    try {
      const o = JSON.parse(p);
      return String(o.content || o.fact || o.text || '').trim() || p;
    } catch {
      // keep raw payload
    }
  }
  return p;
}

function parseEvent(payload: string): EpisodicCommand | null {
  let summary = payload.trim();
  let tags: string[] = [];
  if (summary.startsWith('{') && summary.endsWith('}')) {
    try {
      const o = JSON.parse(summary);
      summary = String(o.summary || o.content || summary).trim();
      if (Array.isArray(o.tags)) tags = splitTags(o.tags);
      else if (typeof o.tags === 'string') tags = splitTags([o.tags]);
    } catch {
      const m = payload.match(/"tags"\s*:\s*"([^"]+)"/i);
      if (m) tags = splitTags([m[1]]);
    }
  }
  return summary ? { summary, tags } : null;
}

export function processMemoryCommands(response: string): MemoryCommands {
  const result: MemoryCommands = { cleaned: (response ?? '').trim(), facts: [], events: [] };
  let text = result.cleaned;
  if (!text) return result;
  const ranges: [number, number][] = [];
  let index = 0;
  while (index < text.length) {
    const start = text.toUpperCase().indexOf('[SAVE_', index);
    if (start < 0) break;
    const colon = text.indexOf(':', start);
    if (colon < 0) break;
    const header = text.slice(start + 1, colon).replace(/\s+/g, '').toUpperCase();
    if (header !== 'SAVE_FACT' && header !== 'SAVE_EVENT') {
      index = start + 6;
      continue;
    }
    const end = findMemoryCommandEnd(text, colon + 1);
    if (end < 0) break;
    const payload = text.slice(colon + 1, end).trim();
    if (header === 'SAVE_FACT') {
      const fact = parseFact(payload);
      if (fact && !result.facts.some((f) => f.toLowerCase() === fact.toLowerCase())) result.facts.push(fact);
    } else {
      const ev = parseEvent(payload);
      if (ev) result.events.push(ev);
    }
    ranges.push([start, end + 1]);
    index = end + 1;
  }
  for (let i = ranges.length - 1; i >= 0; i--) text = text.slice(0, ranges[i][0]) + text.slice(ranges[i][1]);
  result.cleaned = text.replace(/\n{3,}/g, '\n\n').trim();
  return result;
}

export function stripThinking(text: string): string {
  let out = text ?? '';
  for (;;) {
    const start = out.indexOf('<think>');
    if (start < 0) break;
    const end = out.indexOf('</think>', start);
    if (end < 0) {
      out = out.slice(0, start);
      break;
    }
    out = out.slice(0, start) + out.slice(end + 8);
  }
  return out.trim();
}

/** "名前は「X」" / "name is X" / "s'appelle X" → X */
export function extractUserName(fact: string): string {
  const patterns = [
    /(?:ユーザー\s*の\s*)?名前は\s*[「『"']?([^」』"'\s。、.!?！？]+)/,
    /\bname\s+is\s+["']?([\p{L}][\p{L}\p{M}'-]*)/iu,
    /\b(?:s'appelle|s’appelle|prénom est|nom est)\s+["']?([\p{L}][\p{L}\p{M}'-]*)/iu,
  ];
  for (const re of patterns) {
    const m = fact.match(re);
    if (m) return m[1].trim();
  }
  return '';
}

const VOICE_START_RE = /^\[\s*VOICE\s*[:：]/i;
const VOICE_BLOCK_RE = /\[\s*VOICE\s*[:：][^\]]*\]?[ \t]*/gi;

/** Removes [VOICE: ...] lines (an unterminated one at the end included). */
export function stripVoice(text: string): string {
  return text.replace(VOICE_BLOCK_RE, '');
}

export interface FinalReply extends MemoryCommands {
  text: string;
  firstTag: string;
}

/** Full cleanup of a completed reply, as stored in the conversation history. */
export function finalizeReply(raw: string): FinalReply {
  const mem = processMemoryCommands(stripVoice(stripThinking(raw)));
  let text = mem.cleaned;
  let firstTag = '';
  const m = text.match(/\[(NORMAL|SMILE|ANGRY|SAD|SURPRISED|BLUSH|WINK|DISGUST|SMUG|THINKING|PANIC)\]/i);
  if (m) firstTag = m[1].toUpperCase();
  text = text.replace(EMOTION_TAG_RE, '').trim();
  if (text.startsWith('[')) {
    const close = text.indexOf(']');
    if (close > 0) text = text.slice(close + 1).trim();
  }
  return { ...mem, text: text || '……', firstTag };
}

// ─── Streaming display ───

export interface VoiceItem {
  kind: 'voice';
  text: string;
}

export type DisplayItem = { kind: 'char'; ch: string } | { kind: 'emotion'; tag: string } | VoiceItem;

/**
 * Turns raw streamed tokens into displayable characters and emotion changes.
 * Bracketed sequences are held back until they close: emotion tags become
 * emotion events, memory commands disappear, voice lines become voice events,
 * anything else is shown as text.
 */
export class DisplayStream {
  private pending = '';
  private items: DisplayItem[] = [];
  private head = 0;
  raw = '';
  ended = false;
  /** Called as soon as a voice line is complete, long before it is displayed (to synthesise it early). */
  onVoice: (item: VoiceItem) => void = () => {};

  push(token: string): void {
    this.raw += token;
    this.pending += token;
    this.drain(false);
  }

  end(): void {
    this.ended = true;
    this.drain(true);
  }

  /** Next item, or null when nothing is available yet. */
  next(): DisplayItem | null {
    return this.head < this.items.length ? this.items[this.head++] : null;
  }

  /** Upcoming character at the given offset (emotion items skipped); undefined if not received yet. */
  peekChar(offset = 0): string | undefined {
    let seen = 0;
    for (let i = this.head; i < this.items.length; i++) {
      const it = this.items[i];
      if (it.kind !== 'char') continue;
      if (seen === offset) return it.ch;
      seen++;
    }
    return undefined;
  }

  /** Up to n upcoming characters already received. */
  peekText(n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) {
      const ch = this.peekChar(i);
      if (ch === undefined) break;
      s += ch;
    }
    return s;
  }

  /** Whether visible text remains: true/false, or null while the stream may still bring some. */
  moreText(): boolean | null {
    for (let i = this.head; i < this.items.length; i++) {
      const it = this.items[i];
      if (it.kind === 'char' && /\S/.test(it.ch)) return true;
    }
    return this.ended ? false : null;
  }

  /** Displayed text with the voice lines kept in place (emotion tags left out, as in the history). */
  transcript(): string {
    let out = '';
    for (const it of this.items) {
      if (it.kind === 'char') out += it.ch;
      else if (it.kind === 'voice') out += `${out && !/\s$/.test(out) ? ' ' : ''}[VOICE: ${it.text}] `;
    }
    return out.replace(/[ \t]{2,}/g, ' ').trim();
  }

  get exhausted(): boolean {
    return this.ended && this.head >= this.items.length;
  }

  // Whitespace to drop at the start of the next text (after a removed block or a tag).
  private trimNext: 'none' | 'space' | 'all' = 'none';

  private emitText(s: string): void {
    if (this.trimNext !== 'none') {
      s = s.replace(this.trimNext === 'all' ? /^\s+/ : /^[ \t]+/, '');
      if (!s) return;
      this.trimNext = 'none';
    }
    for (const ch of s) this.items.push({ kind: 'char', ch });
  }

  private drain(final: boolean): void {
    for (;;) {
      const p = this.pending;
      const i = p.search(/[[<]/);
      if (i < 0) {
        this.emitText(p);
        this.pending = '';
        return;
      }
      if (i > 0) {
        this.emitText(p.slice(0, i));
        this.pending = p.slice(i);
        continue;
      }
      if (p[0] === '<') {
        if ('<think>'.startsWith(p.slice(0, 7)) && p.length < 7 && !final) return;
        if (p.startsWith('<think>')) {
          const end = p.indexOf('</think>');
          if (end < 0) {
            if (final) this.pending = '';
            return;
          }
          this.pending = p.slice(end + 8);
          this.trimNext = 'all';
          continue;
        }
        this.emitText('<');
        this.pending = p.slice(1);
        continue;
      }
      // p starts with "["
      if (VOICE_START_RE.test(p) || (!final && /^\[\s*V(O(I(C(E\s*)?)?)?)?$/i.test(p))) {
        const colon = p.search(/[:：]/);
        const end = colon >= 0 ? p.indexOf(']', colon + 1) : -1;
        if (end < 0) {
          if (final) this.pending = '';
          return;
        }
        const text = p.slice(colon + 1, end).trim();
        if (text) {
          const item: VoiceItem = { kind: 'voice', text };
          this.items.push(item);
          this.onVoice(item);
        }
        this.pending = p.slice(end + 1);
        if (this.trimNext === 'none') this.trimNext = 'space';
        continue;
      }
      if (/^\[\s*SAVE_/i.test(p) || (!final && /^\[\s*S?A?V?E?_?$/i.test(p))) {
        const colon = p.indexOf(':');
        const end = colon >= 0 ? findMemoryCommandEnd(p, colon + 1) : -1;
        if (end < 0) {
          if (final) this.pending = '';
          return;
        }
        this.pending = p.slice(end + 1);
        this.trimNext = 'all';
        continue;
      }
      const close = p.indexOf(']');
      if (close < 0) {
        if (!final && p.length < 40) return;
        this.emitText('[');
        this.pending = p.slice(1);
        continue;
      }
      const body = p.slice(1, close).trim();
      if (isEmotionTag(body)) {
        this.items.push({ kind: 'emotion', tag: body.toUpperCase() });
        this.pending = p.slice(close + 1);
        if (this.trimNext === 'none') this.trimNext = 'space';
      } else {
        this.emitText(p.slice(0, close + 1));
        this.pending = p.slice(close + 1);
      }
    }
  }
}

// ─── Page breaks ───

const CLOSERS = new Set(['」', '）', ')', '』', '”', '"', "'"]);
const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'vs', 'eg', 'ie', 'etc', 'ca', 'al', 'co', 'corp', 'inc', 'ltd', 'st', 'ave', 'rd', 'vol', 'ed', 'gen', 'rep', 'sen', 'mme', 'mlle', 'm']);

/**
 * Whether a "." ends a sentence: not part of "...", not after a known abbreviation,
 * and followed (after closing quotes) by whitespace or the end of the text.
 * `before` is the text up to and including the period; `after` what follows it.
 */
export function isSentenceEndingPeriod(before: string, after: string, complete: boolean): boolean | 'wait' {
  if (!before.endsWith('.')) return false;
  if (before.endsWith('..')) return false;
  if (after.startsWith('.')) return false;
  const word = before.slice(0, -1).match(/(\p{L}+)$/u)?.[1]?.toLowerCase();
  if (word && ABBREVIATIONS.has(word)) return false;
  let j = 0;
  while (j < after.length && (CLOSERS.has(after[j]) || after[j] === ']' || after[j] === '}')) j++;
  if (j >= after.length) return complete ? true : 'wait';
  return /\s/.test(after[j]);
}

const PAUSE = new Set(['。', '！', '？', '!', '?', '\n']);

/**
 * Visual-novel paging rule from the original typewriter: pause after sentence
 * punctuation, but when a closing bracket/quote follows, pause after it instead.
 */
export function pauseAfter(before: string, after: string, complete: boolean): boolean | 'wait' {
  const c = before[before.length - 1];
  const endsSentence = (text: string, rest: string) => {
    const ch = text[text.length - 1];
    if (PAUSE.has(ch)) return true;
    if (ch === '.') return isSentenceEndingPeriod(text, rest, complete);
    return false;
  };
  if (CLOSERS.has(c)) {
    const prev = endsSentence(before.slice(0, -1), before.slice(-1) + after);
    if (prev === 'wait') return 'wait';
    if (prev) return true;
  }
  const own = endsSentence(before, after);
  if (own === 'wait') return 'wait';
  if (!own) return false;
  if (!after.length) return complete ? true : 'wait';
  return !CLOSERS.has(after[0]);
}

// Long-term memory, ported from MemoryManager.cs: facts about the user with a
// reinforcement "strength", episodic memories, conversation summaries, emotion
// history and session info, persisted locally and injected into the system prompt.

import { stripVoice } from '../chat/parse';
import type { ChatMessage } from '../ai/types';

export interface FactItem {
  content: string;
  strength: number;
  lastUpdated: string;
}

export interface EpisodicItem {
  timestamp: string;
  summary: string;
  tags: string[];
}

export interface KurisuMemory {
  userName: string;
  userFacts: FactItem[];
  conversationSummaries: string[];
  episodicMemory: EpisodicItem[];
  lastSessionDate: string;
  totalInteractions: number;
  recentEmotions: string[];
}

const KEY = 'amadeus.memory.v1';
const MAX_FACTS = 50;
const MAX_EPISODES = 50;
const MAX_SUMMARIES = 10;
const EMOTION_HISTORY = 10;
const MAX_CONVERSATION_MESSAGES = 30;

const pad = (n: number) => String(n).padStart(2, '0');
const today = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const nowStamp = (d = new Date()) => `${today(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const normalizeFact = (s: string) => s.trim().toLowerCase();

function empty(): KurisuMemory {
  return {
    userName: '',
    userFacts: [],
    conversationSummaries: [],
    episodicMemory: [],
    lastSessionDate: '',
    totalInteractions: 0,
    recentEmotions: [],
  };
}

function normalizeTags(tags: unknown): string[] {
  const out: string[] = [];
  const list = Array.isArray(tags) ? tags : typeof tags === 'string' ? [tags] : [];
  for (const raw of list) {
    for (const part of String(raw).split(/[,|、]/)) {
      const tag = part.trim();
      if (tag && !out.some((t) => t.toLowerCase() === tag.toLowerCase())) out.push(tag);
    }
  }
  return out;
}

export class MemoryManager {
  private memory: KurisuMemory = empty();

  constructor() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const loaded = JSON.parse(raw) as Partial<KurisuMemory>;
        this.memory = { ...empty(), ...loaded };
        this.memory.userFacts = (this.memory.userFacts ?? []).filter((f) => f && f.content);
        this.memory.episodicMemory = (this.memory.episodicMemory ?? []).map((e) => ({ ...e, tags: normalizeTags(e.tags) }));
      }
    } catch {
      this.memory = empty();
    }
  }

  private save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.memory));
    } catch {
      // ignore
    }
  }

  get data(): Readonly<KurisuMemory> {
    return this.memory;
  }

  /** Memory block appended to the system prompt (same wording as the original). */
  getMemoryContext(): string {
    const m = this.memory;
    const lines: string[] = [];
    if (m.userName) lines.push(`【ユーザー情報】ユーザーの名前は「${m.userName}」。`);

    if (m.userFacts.length) {
      lines.push('【ユーザーについて知っていること（重要度順）】');
      const ranked = [...m.userFacts].sort(
        (a, b) => b.strength - a.strength || b.lastUpdated.localeCompare(a.lastUpdated) || a.content.localeCompare(b.content),
      );
      for (const fact of ranked.slice(0, 6)) {
        const certainty = fact.strength >= 4 ? '高' : fact.strength >= 2 ? '中' : '低';
        lines.push(`- ${fact.content}（強度:${Math.max(1, fact.strength)} / 信頼度:${certainty}）`);
      }
    }

    if (m.episodicMemory.length) {
      lines.push('【最近のエピソード記憶】');
      const ranked = [...m.episodicMemory].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      for (const ep of ranked.slice(0, 4)) {
        let line = `- [${ep.timestamp}] ${ep.summary}`;
        if (ep.tags.length) line += `（タグ: ${ep.tags.join(', ')}）`;
        lines.push(line);
      }
    }

    if (m.conversationSummaries.length && !m.episodicMemory.length) {
      lines.push('【過去の会話の記憶】');
      for (const s of m.conversationSummaries.slice(-3)) lines.push(`- ${s}`);
    }

    if (m.lastSessionDate) lines.push(`【前回のセッション】${m.lastSessionDate}`);
    if (m.totalInteractions > 0) lines.push(`【累計やりとり回数】${m.totalInteractions}回`);
    if (m.recentEmotions.length >= 3) {
      lines.push(`【最近の感情傾向】${m.recentEmotions.join('→')}（同じ感情が続きすぎないように意識して）`);
    }
    return lines.join('\n');
  }

  /** Time of day, current date/time, turn count and a random mood hint. */
  getDynamicContext(turnCount: number, now = new Date()): string {
    const h = now.getHours();
    const period =
      h >= 5 && h < 10 ? '朝' : h >= 10 && h < 12 ? '午前中' : h >= 12 && h < 14 ? '昼' : h >= 14 && h < 17 ? '午後' : h >= 17 && h < 20 ? '夕方' : h >= 20 ? '夜' : '深夜';
    const moods = ['（今は少しリラックスしている）', '（知的好奇心が高まっている）', '（少し眠そう）', '（何かを考え込んでいる）', '（いつも通りの調子）'];
    return [
      `【現在の状況】時間帯: ${period} / 現在日時: ${nowStamp(now)} / 会話ターン数: ${turnCount}`,
      moods[Math.floor(Math.random() * moods.length)],
    ].join('\n');
  }

  recordEmotion(emotion: string): void {
    this.memory.recentEmotions.push(emotion);
    if (this.memory.recentEmotions.length > EMOTION_HISTORY) this.memory.recentEmotions.shift();
    this.save();
  }

  recordInteraction(): void {
    this.memory.totalInteractions++;
    this.memory.lastSessionDate = nowStamp();
    this.save();
  }

  addUserFact(fact: string): void {
    const cleaned = fact.trim();
    if (!cleaned) return;
    const existing = this.memory.userFacts.find((f) => normalizeFact(f.content) === normalizeFact(cleaned));
    if (existing) {
      existing.strength = Math.max(1, existing.strength) + 1;
      existing.lastUpdated = today();
    } else {
      this.memory.userFacts.push({ content: cleaned, strength: 1, lastUpdated: today() });
      if (this.memory.userFacts.length > MAX_FACTS) this.memory.userFacts.shift();
    }
    this.save();
  }

  setUserName(name: string): void {
    if (!name) return;
    this.memory.userName = name;
    this.save();
  }

  addEpisodicMemory(summary: string, tags: string[] = []): void {
    if (!summary.trim()) return;
    this.memory.episodicMemory.push({ timestamp: today(), summary: summary.trim(), tags: normalizeTags(tags) });
    if (this.memory.episodicMemory.length > MAX_EPISODES) this.memory.episodicMemory.shift();
    this.save();
  }

  addConversationSummary(summary: string): void {
    if (!summary) return;
    this.memory.conversationSummaries.push(summary);
    if (this.memory.conversationSummaries.length > MAX_SUMMARIES) this.memory.conversationSummaries.shift();
    this.addEpisodicMemory(summary, ['要約']);
  }

  /**
   * Sliding window over the conversation: when it grows past 30 messages, the
   * oldest ones are removed and stored as a short summary.
   */
  trimConversationHistory(history: ChatMessage[]): void {
    const nonSystem = history.filter((m) => m.role !== 'system').length;
    if (nonSystem <= MAX_CONVERSATION_MESSAGES) return;
    const toRemove = nonSystem - MAX_CONVERSATION_MESSAGES + 4;
    const removed: string[] = [];
    let idx = history[0]?.role === 'system' ? 1 : 0;
    while (idx < history.length && removed.length < toRemove) {
      const msg = history.splice(idx, 1)[0];
      removed.push(`${msg.role}: ${stripVoice(msg.content)}`);
    }
    // Keep the conversation starting with a user turn (required by some providers).
    while (history[idx] && history[idx].role === 'assistant') history.splice(idx, 1);
    if (!removed.length) return;
    const d = new Date();
    let summary = `[${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}の会話] `;
    summary += removed.map((s) => (s.length > 50 ? s.slice(0, 50) + '...' : s)).join(' / ');
    if (summary.length > 300) summary = summary.slice(0, 300) + '...';
    this.addConversationSummary(summary);
  }

  /** Every stored memory as retrievable documents (for BM25 search). */
  documents(): string[] {
    const m = this.memory;
    return [
      ...m.userFacts.map((f) => f.content),
      ...m.episodicMemory.map((e) => `[${e.timestamp}] ${e.summary}${e.tags.length ? `（タグ: ${e.tags.join(', ')}）` : ''}`),
    ];
  }

  removeFact(index: number): void {
    this.memory.userFacts.splice(index, 1);
    this.save();
  }

  removeEpisode(index: number): void {
    this.memory.episodicMemory.splice(index, 1);
    this.save();
  }

  clearAll(): void {
    this.memory = empty();
    this.save();
  }
}

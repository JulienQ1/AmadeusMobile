// BackLogController.cs: every displayed page, kept for the session.

export interface LogEntry {
  speaker: 'user' | 'kurisu' | 'system';
  text: string;
  time: number;
}

const MAX_ENTRIES = 300;

export class Backlog {
  entries: LogEntry[] = [];

  add(speaker: LogEntry['speaker'], text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.entries.push({ speaker, text: trimmed, time: Date.now() });
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
  }

  clear(): void {
    this.entries = [];
  }
}

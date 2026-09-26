// Conversation flow, ported from AmadeusChatController.cs: input -> waiting for the
// API -> streamed visual-novel typewriter with page breaks -> wait for advance,
// plus auto mode, cancellation, in-character errors, memory, voice and sleep.

import { streamChat, webSearchAvailable } from '../ai/client';
import { finalRules, personaPrompt, webSearchContext } from '../ai/prompts';
import { ApiError, type ApiErrorKind, type ChatMessage } from '../ai/types';
import { se } from '../audio/se';
import { speechLocale, t } from '../i18n';
import type { KurisuAnimator } from '../live2d/animator';
import type { MemoryManager } from '../memory/memory';
import { ragContext } from '../memory/rag';
import { notify, speak, stopSpeaking, vibrate } from '../native/bridge';
import { settings } from '../settings';
import { voice, type VoiceLine } from '../voice/voicevox';
import type { Backlog } from './backlog';
import { DisplayStream, extractUserName, finalizeReply, pauseAfter, type VoiceItem } from './parse';

export type ChatState = 'input' | 'waiting' | 'typing' | 'advance';

export interface DialogueView {
  setState(state: ChatState): void;
  setText(text: string): void;
  setWaitingDots(count: number | null): void;
  setAdvanceIndicator(on: boolean): void;
  setPlaceholder(text: string): void;
  setAuto(on: boolean): void;
}

export interface ChatDeps {
  animator: KurisuAnimator;
  memory: MemoryManager;
  backlog: Backlog;
  view: DialogueView;
  isMenuOpen(): boolean;
  onLatency(ms: number): void;
}

const ERROR_KEYS: Record<ApiErrorKind, string> = {
  no_key: 'err_no_key',
  no_base_url: 'err_no_base_url',
  auth: 'err_bad_key',
  rate: 'err_rate',
  timeout: 'err_timeout',
  network: 'err_network',
  forbidden: 'err_forbidden',
  server: 'err_server',
  model: 'err_model',
  vertex: 'err_vertex',
  refusal: 'err_refusal',
  generic: 'err_generic',
};

const INACTIVITY_SECONDS = 60;
const VOICE_SYNC_WAIT_MS = 2000;
const BASE_CHAR_DELAY = 0.1; // ~human speech speed for Japanese (defaultCharDelay)

export class ChatController {
  state: ChatState = 'input';
  /** Technical message of the last API failure (shown in STATUS and the backlog). */
  lastError = '';
  history: ChatMessage[] = [];
  private turnCount = 0;
  private run = 0;
  private abort: AbortController | null = null;
  private cancelledByUser = false;
  private skip = false;
  private advanceResolve: (() => void) | null = null;
  private autoTimer = 0;
  private inactivity = 0;
  private typingNow = false;
  private ttsSpeaking = false;
  private ttsRun = 0;
  private waitingTimer: ReturnType<typeof setInterval> | undefined;
  /** VOICEVOX lines of the reply being streamed, synthesised ahead of their page. */
  private voiceLines = new WeakMap<VoiceItem, VoiceLine>();
  private voiceErrorShown = false;

  constructor(private d: ChatDeps) {
    d.animator.onEmotionChanged = () => this.updatePlaceholder();
    voice.onError = (message) => {
      console.warn('[VOICEVOX]', message);
      if (this.voiceErrorShown) return;
      this.voiceErrorShown = true;
      this.lastError = message;
      this.d.backlog.add('system', message);
    };
  }

  // ─── Animator host ───

  isMouthMoving(): boolean {
    return (this.typingNow && !this.skip && !voice.busy) || this.ttsSpeaking;
  }

  /** Mouth opening following the loudness of the VOICEVOX voice, null when it is silent. */
  mouthLevel(): number | null {
    return voice.playing ? voice.mouthLevel() : null;
  }

  isSpeaking(): boolean {
    return this.typingNow || this.ttsSpeaking || voice.busy;
  }

  /** Replies are voiced by VOICEVOX (Japanese), whatever the display language. */
  private voicevoxOn(): boolean {
    const s = settings.get();
    return s.tts && s.voiceEngine === 'voicevox';
  }

  isIdleForSneeze(): boolean {
    return this.state === 'input' && !this.typingNow;
  }

  get auto(): boolean {
    return settings.get().autoMode;
  }

  toggleAuto(): void {
    settings.update({ autoMode: !this.auto });
    this.d.view.setAuto(this.auto);
    this.autoTimer = 0;
    se('select');
  }

  // ─── Input ───

  submit(raw: string): boolean {
    const text = raw.trim();
    if (!text || this.state !== 'input') return false;
    this.activity();
    if (text.startsWith('/dev')) {
      this.devCommand(text);
      return true;
    }
    se('send');
    void this.converse(text);
    return true;
  }

  /** Tap on the dialogue box (Enter in the original). */
  tap(): void {
    this.activity();
    if (this.state === 'typing') {
      if (this.advanceResolve) {
        se('select');
        this.advanceResolve();
      } else {
        this.skip = true;
      }
    } else if (this.state === 'advance') {
      se('select');
      this.toInput();
    }
  }

  /** CTRL+C in the original: abort the in-flight request. */
  cancel(): void {
    if (this.state !== 'waiting') return;
    this.cancelledByUser = true;
    this.abort?.abort();
    this.run++;
    this.popPendingUserMessage();
    se('cancel');
    this.toInput();
  }

  /** Any touch or key press: keeps Kurisu awake, wakes her up if she dozed off. */
  activity(): void {
    this.inactivity = 0;
    if (this.d.animator.isSleeping) this.d.animator.processEmotion('NORMAL');
  }

  clearHistory(): void {
    this.abort?.abort();
    this.run++;
    this.history = [];
    this.turnCount = 0;
    stopSpeaking();
    voice.stop();
    this.toInput();
  }

  /** Called every frame by the render loop. */
  tick(dt: number): void {
    if (this.d.isMenuOpen()) return;

    if (this.state === 'input' || this.state === 'advance') {
      this.inactivity += dt;
      if (this.inactivity >= INACTIVITY_SECONDS && !this.d.animator.isSleeping) {
        this.d.animator.processEmotion('SLEEPING');
      }
    } else {
      this.inactivity = 0;
    }

    if (!this.auto || this.ttsSpeaking || voice.busy) return;
    if (this.advanceResolve || this.state === 'advance') {
      this.autoTimer += dt;
      if (this.autoTimer >= settings.get().autoSpeed) {
        this.autoTimer = 0;
        if (this.advanceResolve) this.advanceResolve();
        else this.toInput();
      }
    }
  }

  updatePlaceholder(): void {
    this.d.view.setPlaceholder(this.d.animator.isSleeping ? t('sleeping_placeholder_mobile') : t('enter_message'));
  }

  // ─── States ───

  private setState(state: ChatState): void {
    this.state = state;
    this.d.view.setState(state);
    clearInterval(this.waitingTimer);
    this.d.view.setWaitingDots(null);
    if (state === 'waiting') {
      this.d.view.setText('');
      let dots = 0;
      this.d.view.setWaitingDots(1);
      this.waitingTimer = setInterval(() => {
        dots = (dots % 3) + 1;
        this.d.view.setWaitingDots(dots);
      }, 400);
    }
    if (state === 'advance') {
      this.autoTimer = 0;
      this.d.view.setAdvanceIndicator(true);
    } else {
      this.d.view.setAdvanceIndicator(false);
    }
  }

  private toInput(): void {
    this.advanceResolve?.();
    this.advanceResolve = null;
    this.typingNow = false;
    stopSpeaking();
    voice.stop();
    this.ttsSpeaking = false;
    this.setState('input');
    // Back to a neutral pose when idle, so a tilted emotion does not linger.
    if (!this.d.animator.isSleeping) this.d.animator.processEmotion('NORMAL');
    this.updatePlaceholder();
  }

  private popPendingUserMessage(): void {
    if (this.history.length && this.history[this.history.length - 1].role === 'user') this.history.pop();
  }

  // ─── Conversation ───

  private buildSystem(latestUser: string): { systemStatic: string; systemDynamic: string; finalRules: string; webSearch: boolean } {
    const s = settings.get();
    const memory = this.d.memory.getMemoryContext();
    const systemStatic = [personaPrompt(s.language, s.detailedPersona), memory].filter(Boolean).join('\n\n');
    const webSearch = s.webSearch && webSearchAvailable();
    const dynamic = [this.d.memory.getDynamicContext(this.turnCount)];
    if (webSearch) dynamic.push(webSearchContext(s.language));
    if (s.rag && this.history.length > 1) {
      const rag = ragContext(latestUser, this.d.memory.documents());
      if (rag) dynamic.push(rag);
    }
    const rules = finalRules(s.language, s.detailedPersona, this.voicevoxOn());
    if (rules) dynamic.push(rules);
    return { systemStatic, systemDynamic: dynamic.join('\n\n'), finalRules: rules, webSearch };
  }

  private newRun(): number {
    this.advanceResolve = null;
    return ++this.run;
  }

  private async converse(userText: string): Promise<void> {
    const run = this.newRun();
    this.cancelledByUser = false;
    this.history.push({ role: 'user', content: userText });
    this.turnCount++;
    this.d.memory.trimConversationHistory(this.history);
    this.d.memory.recordInteraction();
    this.d.backlog.add('user', userText);

    const system = this.buildSystem(userText);
    this.setState('waiting');
    const started = performance.now();
    let firstToken = true;
    const ds = new DisplayStream();
    let typing: Promise<void> | null = null;
    this.voiceErrorShown = false;
    if (this.voicevoxOn()) ds.onVoice = (item) => this.voiceLines.set(item, voice.prepare(item.text));

    this.abort = new AbortController();
    try {
      await streamChat({
        ...system,
        messages: [...this.history],
        signal: this.abort.signal,
        onToken: (tok) => {
          if (run !== this.run) return;
          if (firstToken) {
            firstToken = false;
            this.d.onLatency(performance.now() - started);
          }
          ds.push(tok);
          typing ??= this.typewriter(ds, run);
        },
      });
      if (run !== this.run) return;
      ds.end();
      const reply = finalizeReply(ds.raw);
      this.storeMemories(reply);
      // With the Japanese voice, past replies keep their [VOICE: ...] lines: small models
      // copy the format of their own history and would otherwise drop the voice.
      const spoken = this.voicevoxOn() && settings.get().language !== 'ja' ? ds.transcript() : '';
      this.history.push({ role: 'assistant', content: spoken.includes('[VOICE:') ? spoken : reply.text });
      if (reply.firstTag) this.d.memory.recordEmotion(reply.firstTag);
      if (document.hidden && settings.get().notifications) {
        notify(t('amadeus', 'Amadeus'), reply.text.length > 100 ? reply.text.slice(0, 100) : reply.text);
      }
      typing ??= this.typewriter(ds, run);
      await typing;
    } catch (e) {
      if (run !== this.run || this.cancelledByUser) return;
      const err = e instanceof ApiError ? e : new ApiError('generic', String(e));
      console.warn('[AI Error]', err.kind, err.message);
      this.lastError = err.message;
      this.d.backlog.add('system', err.message);
      this.popPendingUserMessage();
      this.showError(err.kind);
    } finally {
      if (run === this.run) this.abort = null;
    }
  }

  private storeMemories(reply: ReturnType<typeof finalizeReply>): void {
    for (const fact of reply.facts) {
      this.d.memory.addUserFact(fact);
      const name = extractUserName(fact);
      if (name) this.d.memory.setUserName(name);
    }
    for (const ev of reply.events) this.d.memory.addEpisodicMemory(ev.summary, ev.tags);
  }

  private showError(kind: ApiErrorKind): void {
    let message = t(ERROR_KEYS[kind] ?? 'err_generic');
    if (kind === 'model') message += ` (${settings.model()})`;
    this.d.animator.processEmotion('ANGRY');
    if (settings.get().haptics) vibrate(60);
    const ds = new DisplayStream();
    ds.push(message);
    ds.end();
    void this.typewriter(ds, this.newRun(), true);
  }

  private devCommand(cmd: string): void {
    const parts = cmd.split(/\s+/);
    if (cmd === '/dev emotion help') {
      const ds = new DisplayStream();
      ds.push(t('dev_help'));
      ds.end();
      void this.typewriter(ds, this.newRun(), true);
    } else if (parts[1] === 'emotion' && parts[2]) {
      const tag = parts[2].toUpperCase();
      if (tag === 'SNEEZE') this.d.animator.sneeze();
      else this.d.animator.processEmotion(tag);
    } else if (cmd === '/dev motion reset') {
      this.d.animator.processEmotion('NORMAL');
    }
  }

  // ─── Typewriter ───

  private frame(): Promise<void> {
    return new Promise((r) => requestAnimationFrame(() => r()));
  }

  private async pauseWhileMenuOpen(run: number): Promise<void> {
    if (!this.d.isMenuOpen()) return;
    const wasTyping = this.typingNow;
    this.typingNow = false;
    while (this.d.isMenuOpen() && run === this.run) await new Promise((r) => setTimeout(r, 100));
    this.typingNow = wasTyping;
  }

  private waitForAdvance(): Promise<void> {
    this.autoTimer = 0;
    this.d.view.setAdvanceIndicator(true);
    return new Promise((resolve) => {
      this.advanceResolve = () => {
        this.advanceResolve = null;
        this.d.view.setAdvanceIndicator(false);
        stopSpeaking();
        resolve();
      };
    });
  }

  /** Full text of the page being typed, once it can be determined (for the voice). */
  private pageText(all: string, page: string, ds: DisplayStream): string | null {
    const upcoming = ds.peekText(400);
    const here = pauseAfter(all, upcoming, ds.ended);
    if (here === 'wait') return null;
    if (here) return page;
    let before = all;
    for (let j = 0; j < upcoming.length; j++) {
      before += upcoming[j];
      const r = pauseAfter(before, upcoming.slice(j + 1), ds.ended);
      if (r === 'wait') return null;
      if (r) return page + upcoming.slice(0, j + 1);
    }
    return ds.ended ? page + upcoming : null;
  }

  private voiceLine(item: VoiceItem): VoiceLine | null {
    if (!this.voicevoxOn()) return null;
    return this.voiceLines.get(item) ?? voice.prepare(item.text);
  }

  private speakPage(text: string): void {
    const s = settings.get();
    const clean = text.trim();
    if (!clean) return;
    if (s.voiceEngine === 'voicevox') {
      // Japanese display: the page itself is the line. Otherwise the reply carries [VOICE: ...] lines.
      if (s.language === 'ja') voice.enqueue(voice.prepare(clean));
      return;
    }
    const id = ++this.ttsRun;
    this.ttsSpeaking = true;
    void speak(clean, { lang: speechLocale(), rate: s.ttsRate, pitch: s.ttsPitch, volume: s.masterVol * s.voiceVol }).then(() => {
      if (id === this.ttsRun) this.ttsSpeaking = false;
    });
  }

  private charDelay(c: string): number {
    const base = BASE_CHAR_DELAY / Math.max(settings.get().textSpeed, 0.1);
    if (c === '、' || c === ',' || c === '…' || c === '.') return base * 2.5;
    if ('」）)』”"\''.includes(c)) return base * 1.5;
    return base;
  }

  private async typewriter(ds: DisplayStream, run: number, isSystemMessage = false): Promise<void> {
    let page = '';
    let all = '';
    let lastLogged = '';
    let started = false;
    let speechPending = true;
    this.skip = false;

    while (run === this.run) {
      await this.pauseWhileMenuOpen(run);
      if (run !== this.run) return;

      const item = ds.next();
      if (!item) {
        if (ds.exhausted) break;
        this.typingNow = false;
        await this.frame();
        continue;
      }
      if (!started) {
        started = true;
        if (item.kind !== 'emotion' && !isSystemMessage) this.d.animator.processEmotion('NORMAL');
        this.setState('typing');
        this.d.view.setText('');
      }
      if (item.kind === 'emotion') {
        this.d.animator.processEmotion(item.tag);
        continue;
      }
      if (item.kind === 'voice') {
        const line = this.voiceLine(item);
        if (line) {
          // Lines of a reply never cut each other (the model may split a sentence into
          // several lines); tapping back to the input box silences the rest.
          const idle = !voice.busy;
          voice.enqueue(line);
          // When nothing is being said, let the text start with the voice (if the synthesis is quick).
          if (idle && !this.skip) await Promise.race([line.audio, new Promise((r) => setTimeout(r, VOICE_SYNC_WAIT_MS))]);
          if (run !== this.run) return;
        }
        continue;
      }

      const c = item.ch;
      if (!page && /\s/.test(c)) continue;
      page += c;
      all += c;
      this.typingNow = true;
      this.d.view.setText(page);

      if (speechPending && settings.get().tts) {
        const text = this.pageText(all, page, ds);
        if (text !== null) {
          speechPending = false;
          this.speakPage(text);
        }
      }

      let pause = pauseAfter(all, ds.peekText(4), ds.ended);
      while (pause === 'wait' && run === this.run) {
        await this.frame();
        pause = pauseAfter(all, ds.peekText(4), ds.ended);
      }
      if (run !== this.run) return;

      if (pause) {
        this.typingNow = false;
        this.skip = false;
        this.d.backlog.add('kurisu', page);
        lastLogged = page;
        let more = ds.moreText();
        while (more === null && run === this.run) {
          await this.frame();
          more = ds.moreText();
        }
        if (run !== this.run) return;
        if (!more) break;
        await this.waitForAdvance();
        if (run !== this.run) return;
        page = '';
        speechPending = true;
      } else if (!this.skip) {
        await new Promise((r) => setTimeout(r, this.charDelay(c) * 1000));
      }
    }
    if (run !== this.run) return;
    // Lines placed after the last sentence (the model did not follow the order) still get played.
    for (let item = ds.next(); item; item = ds.next()) {
      if (item.kind === 'emotion') this.d.animator.processEmotion(item.tag);
      else if (item.kind === 'voice') {
        const line = this.voiceLine(item);
        if (line) voice.enqueue(line);
      }
    }
    this.typingNow = false;
    if (!all) {
      if (!started) this.setState('typing');
      page = '……';
      this.d.view.setText(page);
    }
    if (page && page !== lastLogged) this.d.backlog.add('kurisu', page);
    this.setState('advance');
  }
}

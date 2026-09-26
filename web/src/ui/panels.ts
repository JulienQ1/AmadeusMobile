// CONFIG / STATUS / BACKLOG / CHANGE LOG / HELP panels.

import { webSearchAvailable } from '../ai/client';
import { se } from '../audio/se';
import type { Backlog } from '../chat/backlog';
import type { ChatController } from '../chat/controller';
import { applyI18n, t } from '../i18n';
import type { MemoryManager } from '../memory/memory';
import { nativeInfo, requestNotificationPermission, sttAvailable, ttsAvailable } from '../native/bridge';
import { LANGUAGES, LANGUAGE_NAMES, PROVIDERS, settings, type ProviderId, type Settings, type VoiceEngine } from '../settings';
import { fetchStyles, voice, voicevoxBase, type VoicevoxStyle } from '../voice/voicevox';
import { $, confirmDialog, el } from './dom';

export type PanelKind = 'config' | 'status' | 'backlog' | 'changelog' | 'help';

export interface PanelHost {
  memory: MemoryManager;
  backlog: Backlog;
  chat: ChatController;
  operator(): string;
  fps(): number;
  latency(): { last: number | null; avg: number | null };
  coreVersion(): string;
  onSettingsApplied(changed: (keyof Settings)[]): void;
}

const panel = () => $('#panel');
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let onClose: (() => void) | null = null;

export function isPanelOpen(): boolean {
  return !panel().hidden;
}

export function closePanel(): boolean {
  if (!isPanelOpen()) return false;
  clearInterval(refreshTimer);
  panel().hidden = true;
  se('close');
  const cb = onClose;
  onClose = null;
  cb?.();
  return true;
}

function open(title: string, body: Node[], footer: Node[] = []): void {
  clearInterval(refreshTimer);
  $('#panel-title').textContent = title;
  const b = $('#panel-body');
  b.replaceChildren(...body);
  b.scrollTop = 0;
  const f = $('#panel-footer');
  f.replaceChildren(...footer);
  f.hidden = footer.length === 0;
  applyI18n(panel());
  panel().hidden = false;
}

export function initPanels(): void {
  $('#panel-close').addEventListener('click', () => closePanel());
}

export function openPanel(kind: PanelKind, host: PanelHost): void {
  se('open');
  switch (kind) {
    case 'config': return openConfig(host);
    case 'status': return openStatus(host);
    case 'backlog': return openBacklog(host);
    case 'changelog': return openChangelog();
    case 'help': return openHelp();
  }
}

// ─── CONFIG ───

type Tab = 'system' | 'text' | 'sound' | 'graphics' | 'api' | 'voice' | 'memory';
const TABS: [Tab, string][] = [
  ['system', 'category_system'],
  ['text', 'category_text'],
  ['sound', 'category_sound'],
  ['graphics', 'category_graphics'],
  ['api', 'category_api'],
  ['voice', 'category_voice'],
  ['memory', 'category_memory'],
];

/** Voices of the VOICEVOX engine, kept while the app runs. */
let voicevoxStyles: VoicevoxStyle[] = [];

function openConfig(host: PanelHost, tab: Tab = 'system', keepDraft?: Settings): void {
  const draft: Settings = keepDraft ?? JSON.parse(JSON.stringify(settings.get()));
  const content = el('div');
  const tabs = el('div.tabs');

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    draft[key] = value;
  };

  const row = (label: string, control: Node, note?: string) =>
    el('div.row', {}, el('div', {}, el('div.row-label', { text: label }), note ? el('p.row-note', { text: note }) : null), control);

  const toggle = (labelKey: string, key: keyof Settings, onChange?: (v: boolean) => void) => {
    const sw = el('button.switch', { role: 'switch', 'aria-label': t(labelKey) });
    const paint = () => {
      sw.classList.toggle('on', !!draft[key]);
      sw.setAttribute('aria-checked', String(!!draft[key]));
    };
    sw.addEventListener('click', () => {
      (draft as unknown as Record<string, unknown>)[key] = !draft[key];
      paint();
      se('select');
      onChange?.(!!draft[key]);
    });
    paint();
    return row(t(labelKey), sw);
  };

  const slider = (labelKey: string, key: keyof Settings, min: number, max: number, step: number, fmt: (v: number) => string) => {
    const input = el('input', { type: 'range', min, max, step, value: String(draft[key]) });
    const out = el('output', { text: fmt(Number(draft[key])) });
    input.addEventListener('input', () => {
      (draft as unknown as Record<string, unknown>)[key] = Number(input.value);
      out.textContent = fmt(Number(input.value));
    });
    return row(t(labelKey), el('div.slider', {}, input, out));
  };

  const select = (label: string, value: string, options: [string, string][], onChange: (v: string) => void) => {
    const sel = el('select', { 'aria-label': label });
    for (const [v, text] of options) sel.append(el('option', { value: v, text, selected: v === value }));
    sel.addEventListener('change', () => onChange(sel.value));
    return row(label, sel);
  };

  const text = (label: string, value: string, onInput: (v: string) => void, opts: { type?: string; placeholder?: string; note?: string } = {}) => {
    const input = el('input', {
      type: opts.type ?? 'text',
      value,
      placeholder: opts.placeholder ?? '',
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
    });
    input.addEventListener('input', () => onInput(input.value));
    return el('div.row.stack', {}, el('div.row-label', { text: label }), input, opts.note ? el('p.row-note', { text: opts.note }) : null);
  };

  const pct = (v: number) => `${Math.round(v * 100)}%`;

  const render = (current: Tab) => {
    tabs.replaceChildren(
      ...TABS.map(([id, key]) =>
        el(`button.tab${id === current ? '.active' : ''}` as 'button', {
          text: t(key),
          onclick: () => {
            se('select');
            render(id);
          },
        }),
      ),
    );
    const rows: Node[] = [];
    switch (current) {
      case 'system':
        rows.push(
          select(
            t('setting_display_language'),
            draft.language,
            LANGUAGES.map((l) => [l, LANGUAGE_NAMES[l]]),
            (v) => set('language', v as Settings['language']),
          ),
          toggle('setting_skip_loading', 'skipLoading'),
          toggle('setting_long_press', 'longPressMenu'),
          toggle('setting_eye_tracking', 'gazeTracking'),
          toggle('setting_show_notifications', 'notifications', (on) => on && requestNotificationPermission()),
          toggle('setting_keep_awake', 'keepScreenOn'),
          toggle('setting_haptics', 'haptics'),
        );
        break;
      case 'text':
        rows.push(
          slider('setting_text_speed', 'textSpeed', 0.25, 3, 0.05, pct),
          toggle('setting_auto_mode', 'autoMode'),
          slider('setting_auto_speed', 'autoSpeed', 1, 10, 0.5, (v) => `${v.toFixed(1)}s`),
        );
        break;
      case 'sound':
        rows.push(
          slider('setting_master_vol', 'masterVol', 0, 1, 0.05, pct),
          slider('setting_se_vol', 'seVol', 0, 1, 0.05, pct),
          slider('setting_voice_vol', 'voiceVol', 0, 1, 0.05, pct),
        );
        break;
      case 'graphics':
        rows.push(
          select(
            t('setting_screen_mode'),
            draft.fullscreen ? 'full' : 'window',
            [
              ['full', t('screen_mode_fullscreen')],
              ['window', t('screen_mode_windowed')],
            ],
            (v) => set('fullscreen', v === 'full'),
          ),
          select(
            t('setting_quality'),
            draft.quality,
            [
              ['high', t('quality_high')],
              ['standard', t('quality_standard')],
              ['text', t('quality_text')],
            ],
            (v) => set('quality', v as Settings['quality']),
          ),
          toggle('setting_lightweight', 'lightweight'),
        );
        break;
      case 'api':
        rows.push(...apiRows());
        break;
      case 'voice':
        rows.push(
          toggle('setting_tts', 'tts'),
          select(
            t('setting_voice_engine'),
            draft.voiceEngine,
            [
              ['system', t('voice_engine_system')],
              ['voicevox', t('voice_engine_voicevox')],
            ],
            (v) => {
              set('voiceEngine', v as VoiceEngine);
              // Choosing VOICEVOX means wanting to hear it.
              if (v === 'voicevox') set('tts', true);
              render('voice');
            },
          ),
        );
        if (draft.voiceEngine === 'voicevox') rows.push(...voicevoxRows());
        rows.push(
          slider('setting_tts_rate', 'ttsRate', 0.5, 2, 0.05, pct),
          slider('setting_tts_pitch', 'ttsPitch', 0.5, 2, 0.05, pct),
          toggle('setting_stt', 'stt'),
        );
        if (!ttsAvailable() || !sttAvailable()) rows.push(el('p.row-note', { text: t('mic_unavailable') }));
        break;
      case 'memory':
        rows.push(toggle('setting_rag', 'rag'), ...memoryRows(host, () => render('memory')));
        break;
    }
    content.replaceChildren(...rows);
  };

  const voicevoxRows = (): Node[] => {
    const status = el('p.row-note');
    const credit = el('p.row-note');
    const paintCredit = () => (credit.textContent = `${t('voicevox_credit')} VOICEVOX:${draft.voicevoxName}`);
    const styleSelect = el('select', { 'aria-label': t('setting_voicevox_voice') });
    const fill = (styles: VoicevoxStyle[]) => {
      const current = styles.some((st) => st.id === draft.voicevoxStyle)
        ? []
        : [{ id: draft.voicevoxStyle, speaker: draft.voicevoxName, style: `#${draft.voicevoxStyle}` }];
      styleSelect.replaceChildren(
        ...[...current, ...styles].map((st) =>
          el('option', { value: String(st.id), text: `${st.speaker}（${st.style}）`, selected: st.id === draft.voicevoxStyle }),
        ),
      );
    };
    styleSelect.addEventListener('change', () => {
      const id = Number(styleSelect.value);
      const st = voicevoxStyles.find((x) => x.id === id);
      set('voicevoxStyle', id);
      if (st) set('voicevoxName', st.speaker);
      paintCredit();
    });
    const base = () => voicevoxBase(draft.voicevoxHost, draft.ollamaHost);
    const load = async () => {
      status.textContent = `${t('voicevox_connecting')} ${base()}`;
      try {
        voicevoxStyles = await fetchStyles(base(), typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(15000) : undefined);
        fill(voicevoxStyles);
        status.textContent = t('voicevox_ok').replace('{0}', String(voicevoxStyles.length));
      } catch (e) {
        status.textContent = `${t('voicevox_unreachable')} (${(e as Error)?.message || e})`;
      }
    };
    const listen = () => {
      se('select');
      status.textContent = t('voicevox_synthesizing');
      const line = voice.prepare(
        'ふん、べ、別にあなたのために喋ってるわけじゃないんだからね。',
        { base: base(), styleId: draft.voicevoxStyle, rate: draft.ttsRate, pitch: draft.ttsPitch },
        (message) => (status.textContent = `${t('voicevox_unreachable')} (${message})`),
      );
      void line.audio.then((buf) => buf && (status.textContent = t('voicevox_playing')));
      voice.play(line);
    };
    fill(voicevoxStyles);
    paintCredit();
    void load();
    return [
      el('p.row-note', { text: t('voicevox_note') }),
      text(t('setting_voicevox_host'), draft.voicevoxHost, (v) => set('voicevoxHost', v.trim()), {
        type: 'url',
        placeholder: voicevoxBase('', draft.ollamaHost),
        note: t('voicevox_host_note'),
      }),
      el('div.row.stack', {}, el('div.row-label', { text: t('setting_voicevox_voice') }), styleSelect, credit),
      el('div.row', { style: 'gap:10px;justify-content:flex-start' },
        el('button.btn', { text: t('voicevox_reload'), onclick: () => void load() }),
        el('button.btn', { text: t('voicevox_test'), onclick: listen }),
      ),
      status,
    ];
  };

  const apiRows = (): Node[] => {
    const p = draft.provider;
    const info = PROVIDERS.find((x) => x.id === p)!;
    const rows: Node[] = [
      select(
        t('setting_api_provider'),
        p,
        PROVIDERS.map((x) => [x.id, x.label]),
        (v) => {
          set('provider', v as ProviderId);
          render('api');
        },
      ),
    ];
    const compatible = p === 'openai' && draft.openaiCompatible;
    if (p === 'openai') {
      rows.push(toggle('setting_openai_compatible', 'openaiCompatible', () => render('api')));
      if (compatible) {
        rows.push(
          text(t('setting_openai_base_url'), draft.openaiBaseUrl, (v) => set('openaiBaseUrl', v.trim()), {
            type: 'url',
            placeholder: 'https://api.example.com/v1',
            note: t('setting_openai_base_url_example'),
          }),
        );
      }
    }
    if (info.needsKey || compatible || p === 'ollama') {
      rows.push(
        text(t('setting_api_key'), draft.apiKeys[p] ?? '', (v) => (draft.apiKeys = { ...draft.apiKeys, [p]: v.trim() }), {
          type: 'password',
          placeholder: p === 'ollama' ? '(optional)' : '',
          note: t('api_key_note'),
        }),
      );
    }
    rows.push(
      text(t('setting_model_name'), draft.models[p] ?? '', (v) => (draft.models = { ...draft.models, [p]: v.trim() }), {
        placeholder: info.defaultModel,
        note: t('model_hint'),
      }),
    );
    if (p === 'vertex') {
      rows.push(
        text(t('setting_vertex_project'), draft.vertexProject, (v) => set('vertexProject', v.trim()), { note: t('vertex_note_mobile') }),
        text(t('setting_vertex_location'), draft.vertexLocation, (v) => set('vertexLocation', v.trim()), { placeholder: 'global' }),
      );
    }
    if (p === 'ollama') {
      rows.push(text(t('setting_ollama_host'), draft.ollamaHost, (v) => set('ollamaHost', v.trim()), { type: 'url', note: t('ollama_note') }));
    }
    rows.push(toggle('setting_web_search', 'webSearch'), el('p.row-note', { text: t('web_search_note') }), toggle('setting_persona', 'detailedPersona'));
    return rows;
  };

  const apply = () => {
    const before = settings.get();
    const changed = (Object.keys(draft) as (keyof Settings)[]).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(draft[k]));
    settings.update(draft);
    se('confirm');
    host.onSettingsApplied(changed);
    if (changed.includes('language')) {
      applyI18n();
      openConfig(host, 'system');
      return;
    }
    closePanel();
  };

  render(tab);
  open(t('CONFIG', 'CONFIG'), [tabs, content], [
    el('button.btn', { text: t('cancel'), onclick: () => closePanel() }),
    el('button.btn.primary', { text: t('apply'), onclick: apply }),
  ]);
  $('#panel-title').textContent = 'CONFIG';
}

function memoryRows(host: PanelHost, rerender: () => void): Node[] {
  const m = host.memory.data;
  const rows: Node[] = [];
  rows.push(el('div.row-label', { text: t('memory_facts'), style: 'margin-top:14px;color:var(--amber)' }));
  if (m.userName) rows.push(el('div.memory-item', {}, el('span', { text: `👤 ${m.userName}` })));
  if (!m.userFacts.length && !m.userName) rows.push(el('p.row-note', { text: t('memory_empty') }));
  m.userFacts.forEach((f, i) =>
    rows.push(
      el('div.memory-item', {}, el('span', { text: `${f.content}  (×${f.strength})` }), el('button', {
        text: '×',
        'aria-label': 'delete',
        onclick: () => {
          host.memory.removeFact(i);
          rerender();
        },
      })),
    ),
  );
  rows.push(el('div.row-label', { text: t('memory_episodes'), style: 'margin-top:14px;color:var(--amber)' }));
  if (!m.episodicMemory.length) rows.push(el('p.row-note', { text: t('memory_empty') }));
  m.episodicMemory.forEach((e, i) =>
    rows.push(
      el('div.memory-item', {}, el('span', { text: `[${e.timestamp}] ${e.summary}` }), el('button', {
        text: '×',
        'aria-label': 'delete',
        onclick: () => {
          host.memory.removeEpisode(i);
          rerender();
        },
      })),
    ),
  );
  rows.push(
    el('div.row', { style: 'gap:10px;justify-content:flex-start;border:0;margin-top:12px' },
      el('button.btn', {
        text: t('history_clear'),
        onclick: async () => {
          if (await confirmDialog(t('history_clear_confirm'))) host.chat.clearHistory();
        },
      }),
      el('button.btn.danger', {
        text: t('memory_clear'),
        onclick: async () => {
          if (await confirmDialog(t('memory_clear_confirm'))) {
            host.memory.clearAll();
            rerender();
          }
        },
      }),
    ),
  );
  return rows;
}

// ─── STATUS ───

function openStatus(host: PanelHost): void {
  const table = el('table.status-table');
  const clock = el('p.status-title');
  const info = nativeInfo();
  const syncBar = el('div', { style: 'height:6px;background:rgba(255,255,255,.12);margin-top:6px' }, el('div', { style: 'height:100%;width:0;background:var(--amber-grad);transition:width .5s' }));

  const fill = () => {
    const s = settings.get();
    const now = new Date();
    const p2 = (n: number) => String(n).padStart(2, '0');
    clock.textContent = `${now.getFullYear()}/${p2(now.getMonth() + 1)}/${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;
    const fps = host.fps();
    const target = s.lightweight ? 30 : 60;
    const sync = Math.min(1, fps / target);
    (syncBar.firstChild as HTMLElement).style.width = `${Math.round(sync * 100)}%`;
    const lat = host.latency();
    const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
    const mem = host.memory.data;
    const online = navigator.onLine;
    const rows: [string, Node | string][] = [
      ['SYSTEM_VERSION', `Real Amadeus Mobile v${info.appVersion} (1.3U)`],
      ['SYNCHRONIZATION', el('div', {}, `${Math.round(sync * 100)} %`, syncBar)],
      ['NETWORK', el('span', { text: online ? t('status_online', 'ONLINE') : t('status_offline', 'OFFLINE'), style: `color:${online ? 'var(--ok)' : 'var(--danger)'}` })],
      ['MEMORY', `${heap ? `MEM: ${Math.round(heap / 1048576)} MB · ` : ''}${mem.userFacts.length} facts · ${mem.episodicMemory.length} episodes`],
      ['OPERATOR', host.operator()],
      ['LLM_MODEL', `${settings.provider().label} / ${settings.model()}${s.webSearch && webSearchAvailable() ? ' + web' : ''}`],
      ['LIVE2D_MODEL', s.quality === 'text' ? 'Live2DKurisu v1.0 (text only)' : `Live2DKurisu v1.0 · Cubism Core ${host.coreVersion()}`],
      ['RENDER', s.quality === 'text' ? '—' : `${fps} FPS`],
      ['AVERAGE_LATENCY', lat.avg === null ? '--- ms' : `${Math.round(lat.avg)} ms (last ${Math.round(lat.last ?? 0)} ms)`],
      [
        'NATIVE_TTS',
        s.tts && s.voiceEngine === 'voicevox'
          ? `VOICEVOX:${s.voicevoxName} (#${s.voicevoxStyle}) @ ${voicevoxBase()}`
          : `TTS: ${s.tts ? (ttsAvailable() ? 'ON' : 'N/A') : 'OFF'}`,
      ],
      ['NATIVE_STT', `STT: ${s.stt ? (sttAvailable() ? 'ON' : 'N/A') : 'OFF'}`],
      ['NATIVE_RAG', `RAG: ${s.rag ? 'ON (BM25)' : 'OFF'}`],
      ['INTERACTIONS', String(mem.totalInteractions)],
      ['LAST_ERROR', el('span', { text: host.chat.lastError || '—', style: host.chat.lastError ? 'color:#ff7a7a;word-break:break-word' : '' })],
      ['PLATFORM', info.platform === 'android' ? `Android (API ${info.sdkInt ?? '?'})${info.device ? ` · ${info.device}` : ''}` : 'Web'],
    ];
    table.replaceChildren(...rows.map(([k, v]) => el('tr', {}, el('td', { text: k }), el('td', {}, v))));
  };
  fill();
  open('SYSTEM STATUS', [clock, table, el('p.status-footer', { text: `Amadeus.system — ${t('credits')}` })]);
  refreshTimer = setInterval(fill, 1000);
}

// ─── BACKLOG ───

function openBacklog(host: PanelHost): void {
  const names = { user: t('you', 'You'), kurisu: t('amadeus_kurisu', 'Amadeus Kurisu'), system: 'SYSTEM' };
  const entries = host.backlog.entries.map((e) =>
    el(`div.log-entry${e.speaker === 'kurisu' ? '' : `.${e.speaker}`}` as 'div', {},
      el('div.log-name', { text: names[e.speaker] }),
      el('div.log-text', { text: e.text }),
    ),
  );
  open('BACKLOG', entries.length ? entries : [el('p.row-note', { text: '—' })]);
  const body = $('#panel-body');
  body.scrollTop = body.scrollHeight;
}

// ─── CHANGE LOG ───

function openChangelog(): void {
  const versions: [string, string, string][] = [
    ['Mobile 1.1', '2026. 09. 25', t('changelog_mobile11')],
    ['Mobile 1.0', '2026. 09. 25', t('changelog_mobile10')],
    ['Version 1.3U', '2026. 06. 23', t('changelog_v13')],
    ['Version 1.2U', '2026. 05. 10', t('changelog_v12')],
    ['Version 1.1U', '2026. 03. 27', t('changelog_v11')],
    ['Version 1.0.1', '2026. 02. 23', t('changelog_v101')],
    ['Version 1.0', '2026. 02. 22', t('changelog_v10')],
  ];
  open(
    'CHANGE LOG',
    versions.flatMap(([v, date, body]) => [
      el('h2.changelog-version', { text: v }),
      el('div.changelog-date', { text: date }),
      el('ul.changelog-body', {}, ...body.split('\n').filter(Boolean).map((line) => el('li', { text: line }))),
    ]),
  );
}

// ─── HELP ───

function openHelp(): void {
  const rows: [string, string][] = [
    [t('help_tap_dialogue'), t('help_tap_dialogue_desc')],
    [t('help_long_press'), t('help_long_press_desc')],
    [t('help_auto'), t('help_auto_desc')],
    [t('help_cancel_mobile'), t('help_cancel_chat')],
    [t('help_mic'), t('help_mic_desc')],
    [t('help_gaze'), t('help_gaze_desc')],
    [t('help_back'), t('help_back_desc')],
    ['/dev emotion help', 'Emotion IDs'],
  ];
  open(
    'HELP',
    rows.map(([k, v]) => el('div.help-row', {}, el('span.help-key', { text: k }), el('span', { text: v }))),
  );
}

export function onPanelClosed(cb: () => void): void {
  onClose = cb;
}

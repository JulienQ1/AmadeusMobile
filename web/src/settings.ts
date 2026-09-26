// Persistent settings, mirroring the PlayerPrefs keys of the original ConfigPanel
// (defaults kept identical where the setting still makes sense on a phone).

export type ProviderId = 'openai' | 'gemini' | 'claude' | 'groq' | 'vertex' | 'ollama' | 'openrouter';

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  defaultModel: string;
  needsKey: boolean;
  webSearch: boolean;
}

export const PROVIDERS: ProviderInfo[] = [
  { id: 'openai', label: 'OpenAI', defaultModel: 'gpt-5.5', needsKey: true, webSearch: false },
  { id: 'gemini', label: 'Google Gemini', defaultModel: 'gemini-flash-latest', needsKey: true, webSearch: true },
  { id: 'claude', label: 'Anthropic Claude', defaultModel: 'claude-opus-5', needsKey: true, webSearch: true },
  { id: 'groq', label: 'Groq', defaultModel: 'openai/gpt-oss-20b', needsKey: true, webSearch: true },
  { id: 'vertex', label: 'Vertex AI (Express)', defaultModel: 'gemini-3.8-flash', needsKey: true, webSearch: true },
  { id: 'ollama', label: 'Ollama', defaultModel: 'llama3.2', needsKey: false, webSearch: false },
  { id: 'openrouter', label: 'OpenRouter', defaultModel: 'openrouter/auto', needsKey: true, webSearch: true },
];

export const LANGUAGES = ['ja', 'en', 'zh', 'ko', 'es', 'fr', 'de', 'ru', 'uk', 'pt', 'tr'] as const;
export type Lang = (typeof LANGUAGES)[number];
export const LANGUAGE_NAMES: Record<Lang, string> = {
  ja: '日本語', en: 'English', zh: '中文', ko: '한국어', es: 'Español', fr: 'Français',
  de: 'Deutsch', ru: 'Русский', uk: 'Українська', pt: 'Português', tr: 'Türkçe',
};

export type Quality = 'high' | 'standard' | 'text';
export type VoiceEngine = 'system' | 'voicevox';

export interface Settings {
  language: Lang;
  skipLoading: boolean;
  longPressMenu: boolean;
  notifications: boolean;
  lightweight: boolean;
  gazeTracking: boolean;
  keepScreenOn: boolean;
  haptics: boolean;

  textSpeed: number;
  autoMode: boolean;
  autoSpeed: number;

  masterVol: number;
  bgmVol: number;
  seVol: number;
  voiceVol: number;

  fullscreen: boolean;
  quality: Quality;

  provider: ProviderId;
  apiKeys: Partial<Record<ProviderId, string>>;
  models: Partial<Record<ProviderId, string>>;
  webSearch: boolean;
  openaiCompatible: boolean;
  openaiBaseUrl: string;
  vertexProject: string;
  vertexLocation: string;
  ollamaHost: string;
  detailedPersona: boolean;

  tts: boolean;
  ttsRate: number;
  ttsPitch: number;
  /** 'voicevox': Japanese voice from a VOICEVOX engine on the user's PC. */
  voiceEngine: VoiceEngine;
  /** Empty: the Ollama computer on port 50021. */
  voicevoxHost: string;
  voicevoxStyle: number;
  /** Character name, for the "VOICEVOX:name" credit required by the voice licences. */
  voicevoxName: string;
  stt: boolean;
  rag: boolean;
}

function deviceLanguage(): Lang {
  for (const tag of navigator.languages ?? [navigator.language]) {
    const base = tag.toLowerCase().split('-')[0] as Lang;
    if ((LANGUAGES as readonly string[]).includes(base)) return base;
  }
  return 'en';
}

export function defaultSettings(): Settings {
  return {
    language: deviceLanguage(),
    skipLoading: false,
    longPressMenu: true,
    notifications: true,
    lightweight: false,
    gazeTracking: true,
    keepScreenOn: true,
    haptics: true,
    textSpeed: 1.0,
    autoMode: false,
    autoSpeed: 3.0,
    masterVol: 1.0,
    bgmVol: 0.8,
    seVol: 1.0,
    voiceVol: 1.0,
    fullscreen: true,
    quality: 'high',
    provider: 'openai',
    apiKeys: {},
    models: {},
    webSearch: false,
    openaiCompatible: false,
    openaiBaseUrl: '',
    vertexProject: '',
    vertexLocation: 'global',
    ollamaHost: 'http://192.168.1.10:11434',
    detailedPersona: false,
    tts: false,
    ttsRate: 1.0,
    ttsPitch: 1.1,
    voiceEngine: 'system',
    voicevoxHost: '',
    voicevoxStyle: 2,
    voicevoxName: '四国めたん',
    stt: true,
    rag: true,
  };
}

const KEY = 'amadeus.settings.v1';
type SettingsListener = (s: Settings, changed: (keyof Settings)[]) => void;

class SettingsStore {
  private data: Settings;
  private listeners = new Set<SettingsListener>();

  constructor() {
    this.data = defaultSettings();
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) this.data = { ...this.data, ...JSON.parse(raw) };
    } catch {
      // storage unavailable: keep defaults
    }
  }

  get(): Readonly<Settings> {
    return this.data;
  }

  update(patch: Partial<Settings>): void {
    const changed = (Object.keys(patch) as (keyof Settings)[]).filter(
      (k) => JSON.stringify(this.data[k]) !== JSON.stringify(patch[k]),
    );
    if (!changed.length) return;
    this.data = { ...this.data, ...patch };
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      // ignore quota/private-mode errors
    }
    this.listeners.forEach((fn) => fn(this.data, changed));
  }

  subscribe(fn: SettingsListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  provider(): ProviderInfo {
    return PROVIDERS.find((p) => p.id === this.data.provider) ?? PROVIDERS[0];
  }

  apiKey(id: ProviderId = this.data.provider): string {
    return (this.data.apiKeys[id] ?? '').trim();
  }

  model(id: ProviderId = this.data.provider): string {
    const m = (this.data.models[id] ?? '').trim();
    return m || (PROVIDERS.find((p) => p.id === id)?.defaultModel ?? '');
  }
}

export const settings = new SettingsStore();

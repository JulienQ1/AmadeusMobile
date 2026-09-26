// Bridge to the Android shell (android/java/.../NativeBridge.java), with browser
// fallbacks so the same build also runs as a plain web page during development.
//
// Java -> JS messages arrive through window.__amadeus.dispatch(type, jsonPayload).

interface AndroidBridge {
  info(): string;
  httpStart(id: string, method: string, url: string, headersJson: string, body: string): void;
  httpCancel(id: string): void;
  ttsAvailable(): boolean;
  ttsSpeak(id: string, text: string, lang: string, rate: number, pitch: number, volume: number): void;
  ttsStop(): void;
  sttAvailable(): boolean;
  sttStart(lang: string): void;
  sttStop(): void;
  notify(title: string, text: string): void;
  requestNotificationPermission(): void;
  setImmersive(enabled: boolean): void;
  setKeepScreenOn(enabled: boolean): void;
  vibrate(ms: number): void;
  openUrl(url: string): void;
  moveToBack(): void;
  exitApp(): void;
}

type Listener = (data: any) => void;
const listeners = new Map<string, Set<Listener>>();

(window as any).__amadeus = {
  dispatch(type: string, payload: string) {
    let data: unknown = null;
    try {
      data = payload ? JSON.parse(payload) : null;
    } catch {
      data = payload;
    }
    listeners.get(type)?.forEach((fn) => {
      try {
        fn(data);
      } catch (e) {
        console.error(`[bridge] ${type} listener failed`, e);
      }
    });
  },
};

export function onNative(type: string, fn: Listener): () => void {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type)!.add(fn);
  return () => listeners.get(type)?.delete(fn);
}

const android: AndroidBridge | undefined = (window as any).AmadeusAndroid;
export const isAndroid = !!android;

export interface NativeInfo {
  platform: 'android' | 'web';
  appVersion: string;
  sdkInt?: number;
  device?: string;
}

export function nativeInfo(): NativeInfo {
  if (android) {
    try {
      return { platform: 'android', ...JSON.parse(android.info()) };
    } catch {
      // fall through
    }
  }
  return { platform: 'web', appVersion: __APP_VERSION__ };
}

let seq = 0;
const nextId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`;

function base64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * fetch() replacement that performs the request natively on Android: no CORS
 * restrictions (API providers and a LAN Ollama server behave like in the desktop
 * app) and a streamed response body for server-sent events.
 */
export const appFetch: typeof fetch = (input, init) => {
  if (!android) return fetch(input, init);

  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const headers: Record<string, string> = {};
  new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((v, k) => {
    headers[k] = v;
  });
  const rawBody = init?.body;
  let body = '';
  if (typeof rawBody === 'string') body = rawBody;
  else if (rawBody instanceof ArrayBuffer || ArrayBuffer.isView(rawBody)) body = new TextDecoder().decode(rawBody as ArrayBuffer);
  else if (rawBody != null) return Promise.reject(new TypeError('Unsupported request body type'));

  const id = nextId('h');
  const signal = init?.signal;
  const encoder = new TextEncoder();

  return new Promise<Response>((resolve, reject) => {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let settled = false;
    let finished = false;
    const pending: Uint8Array[] = [];
    let ended = false;
    let failure: Error | null = null;

    const cleanup = () => {
      finished = true;
      off();
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (err: Error) => {
      if (!settled) {
        settled = true;
        reject(err);
      } else if (controller) {
        try {
          controller.error(err);
        } catch {
          // stream already closed
        }
      } else {
        failure = err;
      }
      cleanup();
    };
    const onAbort = () => {
      android.httpCancel(id);
      fail(new DOMException('The operation was aborted.', 'AbortError'));
    };

    type HttpEvent = { id: string; event: string; status?: number; headers?: Record<string, string>; chunk?: string; b64?: string; message?: string };
    const off = onNative('http', (msg: HttpEvent) => {
      if (msg.id !== id || finished) return;
      switch (msg.event) {
        case 'head': {
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              controller = c;
              for (const p of pending) c.enqueue(p);
              pending.length = 0;
              if (failure) c.error(failure);
              else if (ended) c.close();
            },
            cancel() {
              android.httpCancel(id);
              cleanup();
            },
          });
          settled = true;
          const status = msg.status ?? 0;
          resolve(
            new Response(status === 204 || status === 304 ? null : stream, {
              status: status >= 200 && status <= 599 ? status : 502,
              headers: msg.headers ?? {},
            }),
          );
          break;
        }
        case 'data': {
          const bytes = msg.b64 !== undefined ? base64Bytes(msg.b64) : encoder.encode(msg.chunk ?? '');
          if (controller) controller.enqueue(bytes);
          else pending.push(bytes);
          break;
        }
        case 'end':
          if (controller) controller.close();
          else ended = true;
          cleanup();
          break;
        case 'error':
          fail(new TypeError(msg.message || 'Network request failed'));
          break;
      }
    });

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort);
    }
    android.httpStart(id, method, url, JSON.stringify(headers), body);
  });
};

// ─── Text to speech ───

export interface SpeakOptions {
  lang: string;
  rate: number;
  pitch: number;
  volume: number;
}

let webVoice: SpeechSynthesisUtterance | null = null;

export function ttsAvailable(): boolean {
  if (android) {
    try {
      return android.ttsAvailable();
    } catch {
      return false;
    }
  }
  return 'speechSynthesis' in window;
}

/** Speaks text; resolves when speech ends (or fails). onStart fires when audio begins. */
export function speak(text: string, opts: SpeakOptions, onStart?: () => void): Promise<void> {
  stopSpeaking();
  if (android) {
    const id = nextId('t');
    return new Promise((resolve) => {
      const off = onNative('tts', (msg: { id: string; event: string }) => {
        if (msg.id !== id) return;
        if (msg.event === 'start') onStart?.();
        if (msg.event === 'done' || msg.event === 'error' || msg.event === 'stopped') {
          off();
          resolve();
        }
      });
      android.ttsSpeak(id, text, opts.lang, opts.rate, opts.pitch, opts.volume);
    });
  }
  if (!('speechSynthesis' in window)) return Promise.resolve();
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = opts.lang;
    u.rate = opts.rate;
    u.pitch = opts.pitch;
    u.volume = opts.volume;
    u.onstart = () => onStart?.();
    u.onend = () => resolve();
    u.onerror = () => resolve();
    webVoice = u;
    speechSynthesis.speak(u);
  });
}

export function stopSpeaking(): void {
  if (android) {
    android.ttsStop();
    return;
  }
  if ('speechSynthesis' in window && (speechSynthesis.speaking || webVoice)) {
    speechSynthesis.cancel();
    webVoice = null;
  }
}

// ─── Speech to text ───

export interface SttHandlers {
  onPartial(text: string): void;
  onResult(text: string): void;
  onError(code: string): void;
  onEnd(): void;
}

let webRecognizer: any = null;
let sttOff: (() => void) | null = null;

export function sttAvailable(): boolean {
  if (android) {
    try {
      return android.sttAvailable();
    } catch {
      return false;
    }
  }
  return 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;
}

export function startListening(lang: string, h: SttHandlers): void {
  stopListening();
  if (android) {
    sttOff = onNative('stt', (msg: { event: string; text?: string; code?: string }) => {
      switch (msg.event) {
        case 'partial': h.onPartial(msg.text ?? ''); break;
        case 'result': h.onResult(msg.text ?? ''); break;
        case 'error': h.onError(msg.code ?? 'error'); break;
        case 'end':
          sttOff?.();
          sttOff = null;
          h.onEnd();
          break;
      }
    });
    android.sttStart(lang);
    return;
  }
  const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!Ctor) {
    h.onError('unavailable');
    h.onEnd();
    return;
  }
  const r = new Ctor();
  r.lang = lang;
  r.interimResults = true;
  r.maxAlternatives = 1;
  r.onresult = (e: any) => {
    const res = e.results[e.results.length - 1];
    const text = res[0].transcript as string;
    if (res.isFinal) h.onResult(text);
    else h.onPartial(text);
  };
  r.onerror = (e: any) => h.onError(e.error || 'error');
  r.onend = () => {
    webRecognizer = null;
    h.onEnd();
  };
  webRecognizer = r;
  r.start();
}

export function stopListening(): void {
  if (android) {
    if (sttOff) android.sttStop();
    return;
  }
  webRecognizer?.stop();
}

// ─── Misc platform services ───

export function notify(title: string, text: string): void {
  if (android) {
    android.notify(title, text);
    return;
  }
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    new Notification(title, { body: text, icon: 'img/logo.webp' });
  }
}

export function requestNotificationPermission(): void {
  if (android) android.requestNotificationPermission();
  else if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
}

export function setImmersive(enabled: boolean): void {
  if (android) {
    android.setImmersive(enabled);
    return;
  }
  const doc = document as Document & { webkitFullscreenElement?: Element };
  if (enabled && !doc.fullscreenElement) void document.documentElement.requestFullscreen?.().catch(() => undefined);
  if (!enabled && doc.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
}

let wakeLock: { release(): Promise<void> } | null = null;
export function setKeepScreenOn(enabled: boolean): void {
  if (android) {
    android.setKeepScreenOn(enabled);
    return;
  }
  const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } };
  if (enabled && !wakeLock && nav.wakeLock) {
    nav.wakeLock.request('screen').then((l) => (wakeLock = l)).catch(() => undefined);
  } else if (!enabled && wakeLock) {
    void wakeLock.release();
    wakeLock = null;
  }
}

export function vibrate(ms: number): void {
  if (android) android.vibrate(ms);
  else navigator.vibrate?.(ms);
}

export function openUrl(url: string): void {
  if (android) android.openUrl(url);
  else window.open(url, '_blank', 'noopener');
}

export function exitApp(): void {
  if (android) android.exitApp();
  else window.close();
}

export function moveToBack(): void {
  android?.moveToBack();
}

/** Registers the Android back-button handler. Return true when the press was consumed. */
export function onBackButton(handler: () => boolean): void {
  onNative('back', () => {
    if (!handler()) moveToBack();
  });
}

export function onAppState(handler: (state: 'pause' | 'resume') => void): void {
  onNative('app', (msg: { state: 'pause' | 'resume' }) => handler(msg.state));
  document.addEventListener('visibilitychange', () => handler(document.hidden ? 'pause' : 'resume'));
}

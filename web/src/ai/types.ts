export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type ApiErrorKind =
  | 'no_key'
  | 'no_base_url'
  | 'auth'
  | 'rate'
  | 'timeout'
  | 'network'
  | 'forbidden'
  | 'server'
  | 'model'
  | 'vertex'
  | 'refusal'
  | 'generic';

export class ApiError extends Error {
  constructor(public kind: ApiErrorKind, message: string, public status = 0) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface StreamRequest {
  /** Stable part of the system prompt (persona + long-term memory). */
  systemStatic: string;
  /** Per-request part of the system prompt (time, mood, retrieved memories, web search note). */
  systemDynamic: string;
  /** Reply-language and voice rules, already at the end of systemDynamic; repeated after the history for local models. */
  finalRules?: string;
  messages: ChatMessage[];
  webSearch: boolean;
  signal: AbortSignal;
  onToken(text: string): void;
}

export function kindFromStatus(status: number, body: string): ApiErrorKind {
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'model';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate';
  if (status >= 500) return 'server';
  if (status === 400 && /model/i.test(body)) return 'model';
  if (/quota|rate.?limit/i.test(body)) return 'rate';
  return 'generic';
}

export async function errorFromResponse(res: Response, provider: string): Promise<ApiError> {
  let body = '';
  try {
    body = (await res.text()).slice(0, 2000);
  } catch {
    // ignore
  }
  let detail = body;
  try {
    const j = JSON.parse(body);
    detail = j?.error?.message ?? j?.message ?? body;
  } catch {
    // not JSON
  }
  return new ApiError(kindFromStatus(res.status, body), `${provider} ${res.status}: ${detail}`, res.status);
}

export function networkError(e: unknown, provider: string): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof DOMException && e.name === 'AbortError') return new ApiError('generic', 'aborted');
  const msg = e instanceof Error ? e.message : String(e);
  return new ApiError(/timeout|timed out/i.test(msg) ? 'timeout' : 'network', `${provider}: ${msg}`);
}

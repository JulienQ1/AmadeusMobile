// OpenAI Chat Completions streaming, also used for the OpenAI-compatible
// endpoints of Groq, Ollama, OpenRouter and custom base URLs (as in AIService.cs).

import { appFetch } from '../../native/bridge';
import { sseData } from '../sse';
import { ApiError, errorFromResponse, networkError, type StreamRequest } from '../types';

export interface OpenAIOptions {
  providerName: string;
  url: string;
  apiKey: string;
  model: string;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  /** api.openai.com expects max_completion_tokens; compatible servers expect max_tokens. */
  officialOpenAI?: boolean;
  /** Repeat the final rules after the history (small local models lose them otherwise). */
  finalRulesLast?: boolean;
}

export async function streamOpenAI(opts: OpenAIOptions, req: StreamRequest): Promise<string> {
  const system = [req.systemStatic, req.systemDynamic].filter(Boolean).join('\n\n');
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: [
      { role: 'system', content: system },
      ...req.messages.filter((m) => m.role !== 'system'),
      ...(opts.finalRulesLast && req.finalRules ? [{ role: 'system', content: req.finalRules }] : []),
    ],
    stream: true,
    ...(opts.officialOpenAI ? { max_completion_tokens: 4096 } : { max_tokens: 2048 }),
    ...opts.extraBody,
  };
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...opts.extraHeaders };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

  let res: Response;
  try {
    res = await appFetch(opts.url, { method: 'POST', headers, body: JSON.stringify(body), signal: req.signal });
  } catch (e) {
    throw networkError(e, opts.providerName);
  }
  if (!res.ok) throw await errorFromResponse(res, opts.providerName);

  let full = '';
  try {
    for await (const data of sseData(res, req.signal)) {
      if (data === '[DONE]') break;
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.error) {
        const msg = json.error.message ?? JSON.stringify(json.error);
        throw new ApiError(/rate|quota/i.test(msg) ? 'rate' : 'server', `${opts.providerName}: ${msg}`);
      }
      const delta = json.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta) {
        full += delta;
        req.onToken(delta);
      }
    }
  } catch (e) {
    throw networkError(e, opts.providerName);
  }
  return full;
}

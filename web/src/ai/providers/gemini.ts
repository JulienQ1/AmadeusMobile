// Google Gemini (AI Studio) and Vertex AI Express streaming (streamGenerateContent + SSE).

import { appFetch } from '../../native/bridge';
import { sseData } from '../sse';
import { ApiError, errorFromResponse, networkError, type StreamRequest } from '../types';

export interface GeminiOptions {
  providerName: string;
  url: string;
  headers: Record<string, string>;
}

export function geminiUrl(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
}

export function vertexUrl(model: string, apiKey: string, project: string, location: string): string {
  const m = encodeURIComponent(model);
  const key = `alt=sse&key=${encodeURIComponent(apiKey)}`;
  if (!project) return `https://aiplatform.googleapis.com/v1/publishers/google/models/${m}:streamGenerateContent?${key}`;
  const loc = location || 'global';
  const host = loc === 'global' ? 'aiplatform.googleapis.com' : `${loc}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${encodeURIComponent(project)}/locations/${loc}/publishers/google/models/${m}:streamGenerateContent?${key}`;
}

export async function streamGemini(opts: GeminiOptions, req: StreamRequest): Promise<string> {
  const contents = req.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const system = [req.systemStatic, req.systemDynamic].filter(Boolean).join('\n\n');
  const body: Record<string, unknown> = {
    system_instruction: { parts: [{ text: system }] },
    contents,
    generationConfig: { maxOutputTokens: 8192 },
  };
  if (req.webSearch) body.tools = [{ google_search: {} }];

  let res: Response;
  try {
    res = await appFetch(opts.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      body: JSON.stringify(body),
      signal: req.signal,
    });
  } catch (e) {
    throw networkError(e, opts.providerName);
  }
  if (!res.ok) {
    const err = await errorFromResponse(res, opts.providerName);
    if (opts.providerName.startsWith('Vertex') && (err.status === 401 || err.status === 403)) err.kind = 'vertex';
    throw err;
  }

  let full = '';
  let blocked = '';
  try {
    for await (const data of sseData(res, req.signal)) {
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.error) throw new ApiError('server', `${opts.providerName}: ${json.error.message ?? 'error'}`);
      if (json.promptFeedback?.blockReason) blocked = json.promptFeedback.blockReason;
      const cand = json.candidates?.[0];
      if (cand?.finishReason === 'SAFETY' || cand?.finishReason === 'PROHIBITED_CONTENT') blocked = cand.finishReason;
      for (const part of cand?.content?.parts ?? []) {
        if (typeof part.text === 'string' && !part.thought && part.text) {
          full += part.text;
          req.onToken(part.text);
        }
      }
    }
  } catch (e) {
    throw networkError(e, opts.providerName);
  }
  if (!full && blocked) throw new ApiError('refusal', `${opts.providerName}: blocked (${blocked})`);
  return full;
}

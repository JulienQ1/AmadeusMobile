// Provider dispatch, mirroring AIService.SendChatStreaming() of the original.

import { settings } from '../settings';
import { streamClaude } from './providers/claude';
import { geminiUrl, streamGemini, vertexUrl } from './providers/gemini';
import { streamOpenAI } from './providers/openai';
import { ApiError, type ApiErrorKind, type StreamRequest } from './types';

const OPENROUTER_HEADERS = {
  'HTTP-Referer': 'https://github.com/JulienQ1/AmadeusMobile',
  'X-Title': 'Real Amadeus Mobile',
};

export function webSearchAvailable(): boolean {
  const s = settings.get();
  if (s.provider === 'openai') return !s.openaiCompatible && /search/i.test(settings.model());
  return settings.provider().webSearch;
}

async function dispatch(req: StreamRequest): Promise<string> {
  const s = settings.get();
  const provider = settings.provider();
  const key = settings.apiKey();
  const model = settings.model();

  if (s.provider === 'openai' && s.openaiCompatible) {
    const base = s.openaiBaseUrl.trim().replace(/\/+$/, '');
    if (!base) throw new ApiError('no_base_url', 'Base URL is not set');
    return streamOpenAI({ providerName: 'OpenAI compatible', url: `${base}/chat/completions`, apiKey: key, model }, req);
  }
  if (provider.needsKey && !key) throw new ApiError('no_key', 'API Key is not set');

  switch (s.provider) {
    case 'openai':
      return streamOpenAI(
        {
          providerName: 'OpenAI',
          url: 'https://api.openai.com/v1/chat/completions',
          apiKey: key,
          model,
          officialOpenAI: true,
          extraBody: {
            ...(/^(o\d|gpt-5)/.test(model) ? { reasoning_effort: 'low' } : {}),
            ...(req.webSearch && /search/i.test(model) ? { web_search_options: {} } : {}),
          },
        },
        req,
      );
    case 'groq': {
      const compound = req.webSearch;
      return streamOpenAI(
        {
          providerName: 'Groq',
          url: 'https://api.groq.com/openai/v1/chat/completions',
          apiKey: key,
          model: compound ? 'groq/compound' : model,
          extraBody: compound
            ? {}
            : { temperature: 0.85, top_p: 0.9, ...(/qwen/i.test(model) ? { reasoning_format: 'hidden' } : {}) },
        },
        req,
      );
    }
    case 'ollama': {
      const host = (s.ollamaHost.trim() || 'http://localhost:11434').replace(/\/+$/, '');
      return streamOpenAI(
        { providerName: 'Ollama', url: `${host}/v1/chat/completions`, apiKey: key, model, finalRulesLast: true },
        req,
      );
    }
    case 'openrouter':
      return streamOpenAI(
        {
          providerName: 'OpenRouter',
          url: 'https://openrouter.ai/api/v1/chat/completions',
          apiKey: key,
          model,
          extraHeaders: OPENROUTER_HEADERS,
          extraBody: req.webSearch ? { plugins: [{ id: 'web' }] } : {},
        },
        req,
      );
    case 'gemini':
      return streamGemini({ providerName: 'Gemini', url: geminiUrl(model), headers: { 'x-goog-api-key': key } }, req);
    case 'vertex':
      return streamGemini(
        { providerName: 'Vertex AI', url: vertexUrl(model, key, s.vertexProject.trim(), s.vertexLocation.trim()), headers: {} },
        req,
      );
    case 'claude':
      return streamClaude(key, model, req);
  }
}

// Transient failures (overloaded servers are common on free tiers) are retried
// before Kurisu reports an error, as long as nothing has been displayed yet.
const RETRYABLE: ApiErrorKind[] = ['server', 'timeout', 'network', 'rate'];
const RETRY_DELAYS_MS = [1500, 4000];

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export async function streamChat(req: StreamRequest): Promise<string> {
  let emitted = false;
  const tracked: StreamRequest = {
    ...req,
    onToken: (text) => {
      emitted = true;
      req.onToken(text);
    },
  };
  for (let attempt = 0; ; attempt++) {
    try {
      return await dispatch(tracked);
    } catch (e) {
      const retry =
        e instanceof ApiError && RETRYABLE.includes(e.kind) && !emitted && !req.signal.aborted && attempt < RETRY_DELAYS_MS.length;
      if (!retry) throw e;
      console.warn(`[AI] retry ${attempt + 1} after`, e.message);
      await sleep(RETRY_DELAYS_MS[attempt], req.signal);
      if (req.signal.aborted) throw e;
    }
  }
}

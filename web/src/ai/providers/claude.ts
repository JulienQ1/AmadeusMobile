// Anthropic Claude through the official SDK. Requests go through appFetch, so on
// Android they are performed natively; in a browser the SDK sends the
// direct-browser-access header (the user's own key never leaves the device otherwise).

import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { appFetch } from '../../native/bridge';
import { ApiError, kindFromStatus, type StreamRequest } from '../types';

// Models accepting output_config.effort.
const supportsEffort = (m: string) => /claude-(opus-(4-[5-9]|5)|sonnet-(4-6|5)|fable|mythos)/.test(m);
// Models that can hand a declined request to a fallback model server-side.
const supportsFallbacks = (m: string) => /^claude-(opus-5|fable-5|mythos-5)/.test(m);
// Dynamic-filtering web search needs a recent model; others use the basic tool.
const webSearchType = (m: string) =>
  /claude-(opus-(4-[6-9]|5)|sonnet-(4-6|5))/.test(m) ? 'web_search_20260209' : 'web_search_20250305';

function mapError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof Anthropic.APIUserAbortError) return new ApiError('generic', 'aborted');
  if (e instanceof Anthropic.AuthenticationError) return new ApiError('auth', `Claude: ${e.message}`, 401);
  if (e instanceof Anthropic.PermissionDeniedError) return new ApiError('forbidden', `Claude: ${e.message}`, 403);
  if (e instanceof Anthropic.NotFoundError) return new ApiError('model', `Claude: ${e.message}`, 404);
  if (e instanceof Anthropic.RateLimitError) return new ApiError('rate', `Claude: ${e.message}`, 429);
  if (e instanceof Anthropic.InternalServerError) return new ApiError('server', `Claude: ${e.message}`, e.status ?? 500);
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new ApiError('timeout', `Claude: ${e.message}`);
  if (e instanceof Anthropic.APIConnectionError) return new ApiError('network', `Claude: ${e.message}`);
  if (e instanceof Anthropic.APIError) {
    const status = e.status ?? 0;
    return new ApiError(kindFromStatus(status, e.message), `Claude ${status}: ${e.message}`, status);
  }
  return new ApiError('generic', `Claude: ${e instanceof Error ? e.message : String(e)}`);
}

export async function streamClaude(apiKey: string, model: string, req: StreamRequest): Promise<string> {
  const client = new Anthropic({
    apiKey,
    dangerouslyAllowBrowser: true,
    fetch: appFetch,
    maxRetries: 1,
    timeout: 120_000,
  });

  const system: Anthropic.TextBlockParam[] = [{ type: 'text', text: req.systemStatic, cache_control: { type: 'ephemeral' } }];
  if (req.systemDynamic) system.push({ type: 'text', text: req.systemDynamic });
  const messages: Anthropic.MessageParam[] = req.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

  const params = {
    model,
    max_tokens: 16000,
    system,
    messages,
    ...(req.webSearch ? { tools: [{ type: webSearchType(model), name: 'web_search', max_uses: 3 }] } : {}),
    // Short visual-novel replies: low effort keeps latency down.
    ...(supportsEffort(model) ? { output_config: { effort: 'low' } } : {}),
  };

  let full = '';
  const onText = (delta: string) => {
    full += delta;
    req.onToken(delta);
  };
  try {
    let stopReason: string | null;
    if (supportsFallbacks(model)) {
      const stream = client.beta.messages.stream(
        {
          ...(params as BetaMessageStreamParams),
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        },
        { signal: req.signal },
      );
      stream.on('text', onText);
      stopReason = (await stream.finalMessage()).stop_reason;
    } else {
      const stream = client.messages.stream(params as Anthropic.MessageStreamParams, { signal: req.signal });
      stream.on('text', onText);
      stopReason = (await stream.finalMessage()).stop_reason;
    }
    // A mid-stream refusal leaves partial text that must not be kept.
    if (stopReason === 'refusal') throw new ApiError('refusal', 'Claude declined the request');
  } catch (e) {
    throw mapError(e);
  }
  return full;
}

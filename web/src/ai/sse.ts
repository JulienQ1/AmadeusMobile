import { ApiError } from './types';

/**
 * Reads a server-sent-events body and yields each `data:` payload.
 * Aborts with a timeout error if the server stays silent for idleMs.
 */
export async function* sseData(res: Response, signal: AbortSignal, idleMs = 60000): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      void reader.cancel();
    }, idleMs);
  };
  const onAbort = () => void reader.cancel();
  signal.addEventListener('abort', onAbort);
  try {
    arm();
    for (;;) {
      const { value, done } = await reader.read();
      if (timedOut) throw new ApiError('timeout', 'Stream timed out');
      if (signal.aborted) return;
      if (done) break;
      arm();
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('data:')) yield line.slice(5).trimStart();
      }
    }
    const rest = buffer.trim();
    if (rest.startsWith('data:')) yield rest.slice(5).trimStart();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

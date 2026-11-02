import type { LogEntryInput } from '@naufalrf/contracts';
import { createAbortSignal } from './index';

export interface LogShipperConsole {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface CreateLogShipperOptions {
  endpoint: string;
  token: string;
  batchSize?: number;
  flushIntervalMs?: number;
  maxBufferSize?: number;
  timeoutMs?: number;
  autoFlush?: boolean;
  fetchImpl?: typeof fetch;
  console?: LogShipperConsole;
}

export interface LogShipper {
  enqueue(entry: LogEntryInput): void;
  flush(): Promise<void>;
  stop(): Promise<void>;
  pendingCount(): number;
}

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_MAX_BUFFER_SIZE = 200;
const DEFAULT_TIMEOUT_MS = 5000;

export function createLogShipper(options: CreateLogShipperOptions): LogShipper {
  const {
    endpoint,
    token,
    batchSize = DEFAULT_BATCH_SIZE,
    flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
    maxBufferSize = DEFAULT_MAX_BUFFER_SIZE,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    autoFlush = true,
    fetchImpl = fetch,
    console: out = console,
  } = options;

  let buffer: LogEntryInput[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();

  function clearTimer(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  function scheduleTimer(): void {
    if (stopped || flushIntervalMs <= 0 || timer !== undefined) return;

    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, flushIntervalMs);

    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref: () => void }).unref();
    }
  }

  async function send(batch: LogEntryInput[]): Promise<void> {
    const { signal, cleanup } = createAbortSignal(timeoutMs);

    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Token': token,
        },
        body: JSON.stringify({ entries: batch }),
        signal,
      });

      if (!response.ok) {
        out.error(
          `[log-shipper] log shipping failed: HTTP ${response.status}, dropped ${batch.length} entries`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      out.error(`[log-shipper] log shipping failed: ${message}, dropped ${batch.length} entries`);
    } finally {
      cleanup();
    }
  }

  async function drain(): Promise<void> {
    while (buffer.length > 0) {
      const batch = buffer.splice(0, batchSize);
      await send(batch);
    }
  }

  function flush(): Promise<void> {
    clearTimer();

    inFlight = inFlight.then(drain, drain);
    return inFlight;
  }

  return {
    enqueue(entry) {
      if (stopped) return;

      buffer.push(entry);

      if (buffer.length > maxBufferSize) {
        buffer.splice(0, buffer.length - maxBufferSize);
      }

      if (autoFlush && buffer.length >= batchSize) {
        void flush();
        return;
      }

      scheduleTimer();
    },

    flush,

    async stop() {
      clearTimer();
      const pending = flush();
      stopped = true;
      await pending;
      buffer = [];
    },

    pendingCount() {
      return buffer.length;
    },
  };
}

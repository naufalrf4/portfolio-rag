import { describe, it, expect } from 'bun:test';
import type { LogEntryInput } from '@naufalrf/contracts';
import { createLogShipper } from '../src/log-shipper';

function entry(overrides: Partial<LogEntryInput> = {}): LogEntryInput {
  return {
    timestamp: '2026-08-28T02:00:00.000Z',
    level: 'error',
    service: 'public-astro',
    message: 'probe',
    ...overrides,
  };
}

interface StubCall {
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

function stubFetch(
  responder: (call: StubCall) => { status: number; json?: unknown } | Promise<never>,
) {
  const calls: StubCall[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) {
      for (const [k, v] of Object.entries(rawHeaders as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    const call: StubCall = {
      url: String(input),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      headers,
    };
    calls.push(call);
    const result = await responder(call);
    return new Response(JSON.stringify(result.json ?? {}), {
      status: result.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { calls, impl: impl as unknown as typeof fetch };
}

function silentConsole() {
  const lines: string[] = [];
  return {
    lines,
    console: {
      log: (...args: unknown[]) => lines.push(args.map(String).join(' ')),
      error: (...args: unknown[]) => lines.push(args.map(String).join(' ')),
    },
  };
}

const okResponder = (call: StubCall) => {
  const body = call.body as { entries?: unknown[] } | undefined;
  const count = body?.entries?.length ?? 0;
  return { status: 202, json: { success: true, data: { accepted: count, stored: count } } };
};

describe('createLogShipper', () => {
  it('does not flush before the batch size is reached', async () => {
    const f = stubFetch(okResponder);
    const c = silentConsole();
    const shipper = createLogShipper({
      endpoint: 'http://admin:3001/api/v1/internal/logs',
      token: 't',
      batchSize: 3,
      flushIntervalMs: 0,
      fetchImpl: f.impl,
      console: c.console,
    });

    shipper.enqueue(entry());
    shipper.enqueue(entry());
    await Promise.resolve();

    expect(f.calls).toHaveLength(0);
    expect(shipper.pendingCount()).toBe(2);
  });

  it('flushes automatically once the batch size is reached', async () => {
    const f = stubFetch(okResponder);
    const c = silentConsole();
    const shipper = createLogShipper({
      endpoint: 'http://admin:3001/api/v1/internal/logs',
      token: 't',
      batchSize: 3,
      flushIntervalMs: 0,
      fetchImpl: f.impl,
      console: c.console,
    });

    shipper.enqueue(entry({ message: 'a' }));
    shipper.enqueue(entry({ message: 'b' }));
    shipper.enqueue(entry({ message: 'c' }));
    await shipper.flush();

    expect(f.calls).toHaveLength(1);
    const body = f.calls[0]?.body as { entries: LogEntryInput[] };
    expect(body.entries).toHaveLength(3);
    expect(shipper.pendingCount()).toBe(0);
  });

  it('flushes on the timer when the batch size is never reached', async () => {
    const f = stubFetch(okResponder);
    const c = silentConsole();
    const shipper = createLogShipper({
      endpoint: 'http://admin:3001/api/v1/internal/logs',
      token: 't',
      batchSize: 50,
      flushIntervalMs: 20,
      fetchImpl: f.impl,
      console: c.console,
    });

    shipper.enqueue(entry());
    expect(f.calls).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(f.calls).toHaveLength(1);
    shipper.stop();
  });

  it('sends the service token header and posts to the endpoint', async () => {
    const f = stubFetch(okResponder);
    const c = silentConsole();
    const shipper = createLogShipper({
      endpoint: 'http://admin:3001/api/v1/internal/logs',
      token: 'secret-token',
      batchSize: 1,
      flushIntervalMs: 0,
      fetchImpl: f.impl,
      console: c.console,
    });

    shipper.enqueue(entry());
    await shipper.flush();

    expect(f.calls[0]?.url).toBe('http://admin:3001/api/v1/internal/logs');
    expect(f.calls[0]?.headers['x-service-token']).toBe('secret-token');
    expect(f.calls[0]?.headers['content-type']).toBe('application/json');
  });

  it('drops the oldest entries when the bounded buffer overflows', async () => {
    const f = stubFetch(okResponder);
    const c = silentConsole();
    const shipper = createLogShipper({
      endpoint: 'http://admin:3001/api/v1/internal/logs',
      token: 't',
      batchSize: 1000,
      maxBufferSize: 3,
      flushIntervalMs: 0,
      fetchImpl: f.impl,
      console: c.console,
    });

    shipper.enqueue(entry({ message: 'oldest' }));
    shipper.enqueue(entry({ message: 'second' }));
    shipper.enqueue(entry({ message: 'third' }));
    shipper.enqueue(entry({ message: 'newest' }));

    expect(shipper.pendingCount()).toBe(3);

    await shipper.flush();

    const body = f.calls[0]?.body as { entries: LogEntryInput[] };
    const messages = body.entries.map((e) => e.message);
    expect(messages).toEqual(['second', 'third', 'newest']);
    expect(messages).not.toContain('oldest');
  });

  it('does not throw when the transport rejects', async () => {
    const f = stubFetch(() => Promise.reject(new Error('network down')));
    const c = silentConsole();
    const shipper = createLogShipper({
      endpoint: 'http://admin:3001/api/v1/internal/logs',
      token: 't',
      batchSize: 1,
      flushIntervalMs: 0,
      fetchImpl: f.impl,
      console: c.console,
    });

    shipper.enqueue(entry());

    await expect(shipper.flush()).resolves.toBeUndefined();
    expect(c.lines.join('\n')).toContain('log shipping failed');
  });

  it('drops the batch after a transport failure rather than retrying forever', async () => {
    const f = stubFetch(() => Promise.reject(new Error('network down')));
    const c = silentConsole();
    const shipper = createLogShipper({
      endpoint: 'http://admin:3001/api/v1/internal/logs',
      token: 't',
      batchSize: 1,
      flushIntervalMs: 0,
      fetchImpl: f.impl,
      console: c.console,
    });

    shipper.enqueue(entry());
    await shipper.flush();

    expect(shipper.pendingCount()).toBe(0);
  });

  it('does not throw when the endpoint returns a non-2xx status', async () => {
    const f = stubFetch(() => ({ status: 500, json: { success: false } }));
    const c = silentConsole();
    const shipper = createLogShipper({
      endpoint: 'http://admin:3001/api/v1/internal/logs',
      token: 't',
      batchSize: 1,
      flushIntervalMs: 0,
      fetchImpl: f.impl,
      console: c.console,
    });

    shipper.enqueue(entry());

    await expect(shipper.flush()).resolves.toBeUndefined();
    expect(shipper.pendingCount()).toBe(0);
  });

  it('logs the failure only once per dropped batch', async () => {
    const f = stubFetch(() => Promise.reject(new Error('network down')));
    const c = silentConsole();
    const shipper = createLogShipper({
      endpoint: 'http://admin:3001/api/v1/internal/logs',
      token: 't',
      batchSize: 2,
      flushIntervalMs: 0,
      fetchImpl: f.impl,
      console: c.console,
    });

    shipper.enqueue(entry());
    shipper.enqueue(entry());
    await shipper.flush();

    const failureLines = c.lines.filter((l) => l.includes('log shipping failed'));
    expect(failureLines).toHaveLength(1);
  });

  it('flush() on an empty buffer makes no request', async () => {
    const f = stubFetch(okResponder);
    const c = silentConsole();
    const shipper = createLogShipper({
      endpoint: 'http://admin:3001/api/v1/internal/logs',
      token: 't',
      batchSize: 5,
      flushIntervalMs: 0,
      fetchImpl: f.impl,
      console: c.console,
    });

    await shipper.flush();

    expect(f.calls).toHaveLength(0);
  });

  it('splits a buffer larger than the batch size into multiple requests', async () => {
    const f = stubFetch(okResponder);
    const c = silentConsole();
    const shipper = createLogShipper({
      endpoint: 'http://admin:3001/api/v1/internal/logs',
      token: 't',
      batchSize: 2,
      maxBufferSize: 100,
      flushIntervalMs: 0,
      autoFlush: false,
      fetchImpl: f.impl,
      console: c.console,
    });

    for (let i = 0; i < 5; i += 1) {
      shipper.enqueue(entry({ message: `m${i}` }));
    }
    await shipper.flush();

    expect(f.calls).toHaveLength(3);
    const sizes = f.calls.map((call) => (call.body as { entries: unknown[] }).entries.length);
    expect(sizes).toEqual([2, 2, 1]);
    expect(shipper.pendingCount()).toBe(0);
  });

  it('stop() flushes what is buffered', async () => {
    const f = stubFetch(okResponder);
    const c = silentConsole();
    const shipper = createLogShipper({
      endpoint: 'http://admin:3001/api/v1/internal/logs',
      token: 't',
      batchSize: 50,
      flushIntervalMs: 5000,
      fetchImpl: f.impl,
      console: c.console,
    });

    shipper.enqueue(entry());
    await shipper.stop();

    expect(f.calls).toHaveLength(1);
  });

  it('stops flushing after stop()', async () => {
    const f = stubFetch(okResponder);
    const c = silentConsole();
    const shipper = createLogShipper({
      endpoint: 'http://admin:3001/api/v1/internal/logs',
      token: 't',
      batchSize: 50,
      flushIntervalMs: 20,
      fetchImpl: f.impl,
      console: c.console,
    });

    await shipper.stop();
    shipper.enqueue(entry());
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(f.calls).toHaveLength(0);
  });

  it('never lets a malformed success body throw', async () => {
    const f = stubFetch(() => ({ status: 202, json: { unexpected: true } }));
    const c = silentConsole();
    const shipper = createLogShipper({
      endpoint: 'http://admin:3001/api/v1/internal/logs',
      token: 't',
      batchSize: 1,
      flushIntervalMs: 0,
      fetchImpl: f.impl,
      console: c.console,
    });

    shipper.enqueue(entry());

    await expect(shipper.flush()).resolves.toBeUndefined();
  });
});

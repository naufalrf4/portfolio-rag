import { describe, it, expect } from 'bun:test';
import {
  isAbortError,
  createAbortSignal,
  HttpError,
  getErrorMessage,
  buildProxyHeaders,
  isSuccessEnvelope,
} from '../src/index';

describe('isAbortError', () => {
  it('detects AbortError by name', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(isAbortError(err)).toBe(true);
  });

  it('detects TimeoutError by name', () => {
    const err = new Error('timed out');
    err.name = 'TimeoutError';
    expect(isAbortError(err)).toBe(true);
  });

  it('returns false for generic error', () => {
    expect(isAbortError(new Error('oops'))).toBe(false);
  });

  it('returns false for non-Error', () => {
    expect(isAbortError('timeout')).toBe(false);
  });
});

describe('createAbortSignal', () => {
  it('creates an abort signal with cleanup', () => {
    const { signal, cleanup } = createAbortSignal(10);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
    expect(typeof cleanup).toBe('function');
    cleanup();
  });

  it('aborts after timeout', async () => {
    const { signal, cleanup } = createAbortSignal(5);
    await new Promise((r) => setTimeout(r, 10));
    expect(signal.aborted).toBe(true);
    cleanup();
  });
});

describe('HttpError', () => {
  it('sets name and message', () => {
    const err = new HttpError('boom');
    expect(err.name).toBe('HttpError');
    expect(err.message).toBe('boom');
    expect(err.cause).toBeUndefined();
  });

  it('stores cause', () => {
    const cause = new Error('root');
    const err = new HttpError('boom', cause);
    expect(err.cause).toBe(cause);
  });
});

describe('getErrorMessage', () => {
  it('returns string as-is', () => {
    expect(getErrorMessage('plain string')).toBe('plain string');
  });

  it('returns Error.message', () => {
    expect(getErrorMessage(new Error('msg'))).toBe('msg');
  });

  it('returns object.message', () => {
    expect(getErrorMessage({ message: 'obj msg' })).toBe('obj msg');
  });

  it('returns object.error string', () => {
    expect(getErrorMessage({ error: 'err string' })).toBe('err string');
  });

  it('returns nested error.message', () => {
    expect(getErrorMessage({ error: { message: 'nested' } })).toBe('nested');
  });

  it('returns fallback for unknown shapes', () => {
    expect(getErrorMessage(null, 'fallback')).toBe('fallback');
    expect(getErrorMessage(42, 'fallback')).toBe('fallback');
  });
});

describe('buildProxyHeaders', () => {
  it('sets source headers', () => {
    const h = buildProxyHeaders('test-app', '/test');
    expect(h.get('content-type')).toBe('application/json');
    expect(h.get('x-portfolio-source-app')).toBe('test-app');
    expect(h.get('x-portfolio-source-path')).toBe('/test');
    expect(h.get('x-portfolio-timezone')).toBeNull();
  });

  it('sets timezone', () => {
    const h = buildProxyHeaders('test-app', '/test', undefined, 'Asia/Jakarta');
    expect(h.get('x-portfolio-timezone')).toBe('Asia/Jakarta');
  });

  it('forwards request headers', () => {
    const reqHeaders = new Headers({
      'user-agent': 'test/1.0',
      'x-irrelevant': 'skip',
    });
    const h = buildProxyHeaders('app', '/', reqHeaders);
    expect(h.get('user-agent')).toBe('test/1.0');
    expect(h.get('x-irrelevant')).toBeNull();
  });

  it('drops client-supplied x-forwarded-for when no trusted socket address is given', () => {
    const reqHeaders = new Headers({ 'x-forwarded-for': '9.9.9.9' });
    const h = buildProxyHeaders('app', '/', reqHeaders);
    expect(h.get('x-forwarded-for')).toBeNull();
  });

  it('appends the trusted socket address as the last hop', () => {
    const reqHeaders = new Headers({ 'x-forwarded-for': '9.9.9.9' });
    const h = buildProxyHeaders('app', '/', reqHeaders, undefined, '1.2.3.4');
    expect(h.get('x-forwarded-for')).toBe('9.9.9.9, 1.2.3.4');
  });

  it('sets the socket address alone when no inbound chain exists', () => {
    const h = buildProxyHeaders('app', '/', new Headers(), undefined, '1.2.3.4');
    expect(h.get('x-forwarded-for')).toBe('1.2.3.4');
  });

  it('truncates long values', () => {
    const reqHeaders = new Headers({ referer: 'a'.repeat(600) });
    const h = buildProxyHeaders('app', '/', reqHeaders);
    const val = h.get('referer');
    expect(val).not.toBeNull();
    expect(val!.length).toBeLessThanOrEqual(512);
  });

  it('handles empty request headers', () => {
    const h = buildProxyHeaders('app', '/', new Headers());
    expect(h.get('x-portfolio-source-app')).toBe('app');
  });
});

describe('isSuccessEnvelope', () => {
  it('detects success envelope', () => {
    expect(isSuccessEnvelope({ success: true, data: 'hi' })).toBe(true);
    expect(isSuccessEnvelope({ success: true, data: 'hi', message: 'ok' })).toBe(
      true,
    );
  });

  it('rejects error envelope', () => {
    expect(
      isSuccessEnvelope({
        success: false,
        error: { message: 'nope' },
      }),
    ).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(isSuccessEnvelope(null)).toBe(false);
    expect(isSuccessEnvelope('string')).toBe(false);
    expect(isSuccessEnvelope([])).toBe(false);
  });

  it('rejects missing data', () => {
    expect(isSuccessEnvelope({ success: true })).toBe(false);
  });
});

import { describe, it, expect } from 'bun:test';
import type { LogEntryInput } from '@naufalrf/contracts';
import { createLogger } from '../src/logger';

function collector() {
  const entries: LogEntryInput[] = [];
  const lines: string[] = [];
  return {
    entries,
    lines,
    sink: (entry: LogEntryInput) => {
      entries.push(entry);
    },
    console: {
      log: (...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      },
      error: (...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      },
    },
  };
}

describe('createLogger', () => {
  it('stamps service and level on every entry', () => {
    const c = collector();
    const logger = createLogger({ service: 'admin', sink: c.sink, console: c.console });

    logger.info('hello');
    logger.warn('careful');

    expect(c.entries).toHaveLength(2);
    expect(c.entries[0]?.service).toBe('admin');
    expect(c.entries[0]?.level).toBe('info');
    expect(c.entries[0]?.message).toBe('hello');
    expect(c.entries[1]?.level).toBe('warn');
  });

  it('emits an ISO-8601 timestamp', () => {
    const c = collector();
    const logger = createLogger({
      service: 'admin',
      sink: c.sink,
      console: c.console,
      now: () => new Date('2026-08-28T02:00:00.000Z'),
    });

    logger.info('pinned');

    expect(c.entries[0]?.timestamp).toBe('2026-08-28T02:00:00.000Z');
  });

  it('always mirrors to stdout even when a sink is attached', () => {
    const c = collector();
    const logger = createLogger({ service: 'admin', sink: c.sink, console: c.console });

    logger.info('mirrored');

    expect(c.lines.length).toBeGreaterThan(0);
    expect(c.lines.join('\n')).toContain('mirrored');
  });

  it('mirrors to stdout when no sink is attached', () => {
    const c = collector();
    const logger = createLogger({ service: 'admin', console: c.console });

    logger.error('no sink', new Error('boom'));

    expect(c.lines.join('\n')).toContain('no sink');
  });

  it('flattens an Error into errorName and errorMessage', () => {
    const c = collector();
    const logger = createLogger({ service: 'admin', sink: c.sink, console: c.console });

    logger.error('failed', new TypeError('bad input'));

    expect(c.entries[0]?.errorName).toBe('TypeError');
    expect(c.entries[0]?.errorMessage).toBe('bad input');
  });

  it('labels non-Error throwables as UnknownError', () => {
    const c = collector();
    const logger = createLogger({ service: 'admin', sink: c.sink, console: c.console });

    logger.error('failed', 'just a string');

    expect(c.entries[0]?.errorName).toBe('UnknownError');
    expect(c.entries[0]?.errorMessage).toBe('just a string');
  });

  it('includes the stack in development', () => {
    const c = collector();
    const logger = createLogger({
      service: 'admin',
      sink: c.sink,
      console: c.console,
      isDevelopment: true,
    });

    logger.error('failed', new Error('boom'));

    expect(c.entries[0]?.errorStack).toBeTruthy();
  });

  it('omits the stack in production', () => {
    const c = collector();
    const logger = createLogger({
      service: 'admin',
      sink: c.sink,
      console: c.console,
      isDevelopment: false,
    });

    logger.error('failed', new Error('boom'));

    expect(c.entries[0]?.errorStack).toBeUndefined();
  });

  it('keeps context as structured fields', () => {
    const c = collector();
    const logger = createLogger({ service: 'admin', sink: c.sink, console: c.console });

    logger.info('with context', { userId: 'u1', attempt: 2 });

    expect(c.entries[0]?.context).toEqual({ userId: 'u1', attempt: 2 });
  });

  it('accepts context alongside an error on error()', () => {
    const c = collector();
    const logger = createLogger({ service: 'admin', sink: c.sink, console: c.console });

    logger.error('failed', new Error('boom'), { route: '/x' });

    expect(c.entries[0]?.context).toEqual({ route: '/x' });
    expect(c.entries[0]?.errorMessage).toBe('boom');
  });

  it('suppresses debug in production', () => {
    const c = collector();
    const logger = createLogger({
      service: 'admin',
      sink: c.sink,
      console: c.console,
      isDevelopment: false,
    });

    logger.debug('noisy');

    expect(c.entries).toHaveLength(0);
  });

  it('emits debug in development', () => {
    const c = collector();
    const logger = createLogger({
      service: 'admin',
      sink: c.sink,
      console: c.console,
      isDevelopment: true,
    });

    logger.debug('noisy');

    expect(c.entries).toHaveLength(1);
    expect(c.entries[0]?.level).toBe('debug');
  });

  it('records request() duration as a numeric durationMs, not a string', () => {
    const c = collector();
    const logger = createLogger({ service: 'admin', sink: c.sink, console: c.console });

    logger.request('GET', '/api/v1/public/projects', 200, 42);

    const entry = c.entries[0];
    expect(entry?.durationMs).toBe(42);
    expect(entry?.route).toBe('/api/v1/public/projects');
    expect(entry?.statusCode).toBe(200);
    expect(JSON.stringify(entry)).not.toContain('42ms');
  });

  it('records database() duration as a numeric durationMs in development', () => {
    const c = collector();
    const logger = createLogger({
      service: 'admin',
      sink: c.sink,
      console: c.console,
      isDevelopment: true,
    });

    logger.database('select', 'projects', 7);

    expect(c.entries[0]?.durationMs).toBe(7);
    expect(c.entries[0]?.context).toMatchObject({ operation: 'select', table: 'projects' });
  });

  it('never throws when the sink throws', () => {
    const c = collector();
    const logger = createLogger({
      service: 'admin',
      sink: () => {
        throw new Error('sink exploded');
      },
      console: c.console,
    });

    expect(() => logger.info('still fine')).not.toThrow();
    expect(c.lines.join('\n')).toContain('still fine');
  });

  it('lifts correlationId out of context onto the entry', () => {
    const c = collector();
    const logger = createLogger({ service: 'admin', sink: c.sink, console: c.console });

    logger.info('correlated', { correlationId: 'abc-123' });

    expect(c.entries[0]?.correlationId).toBe('abc-123');
    expect(c.entries[0]?.context).toBeUndefined();
  });
});

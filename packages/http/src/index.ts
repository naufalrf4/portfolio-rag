const FORWARDED_HEADER_NAMES = [
  'x-forwarded-for',
  'user-agent',
  'accept-language',
  'referer',
] as const;

function normalizeHeaderValue(
  value: string | null | undefined,
  maxLength: number,
): string | null {
  if (!value) return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

export function createAbortSignal(
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timeoutId),
  };
}

export class HttpError extends Error {
  cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.cause = cause;
  }
}

export function getErrorMessage(
  error: unknown,
  fallback = 'An unexpected error occurred',
): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const obj = error as Record<string, unknown>;
    if (typeof obj.message === 'string') return obj.message;
    if (typeof obj.error === 'string') return obj.error;
    if (obj.error && typeof obj.error === 'object') {
      const inner = obj.error as Record<string, unknown>;
      if (typeof inner.message === 'string') return inner.message;
    }
  }
  return fallback;
}

export function buildProxyHeaders(
  sourceApp: string,
  sourcePath: string,
  requestHeaders?: Headers,
  timezone?: string,
  clientAddress?: string,
): Headers {
  const headers = new Headers({
    'Content-Type': 'application/json',
    'x-portfolio-source-app': sourceApp,
    'x-portfolio-source-path': sourcePath,
  });

  if (requestHeaders) {
    for (const headerName of FORWARDED_HEADER_NAMES) {
      const maxLen = headerName === 'referer' ? 512 : 255;
      const value = normalizeHeaderValue(requestHeaders.get(headerName), maxLen);
      if (value) headers.set(headerName, value);
    }
  }

  const socketIp = normalizeHeaderValue(clientAddress, 64);
  const inboundChain = headers.get('x-forwarded-for');
  if (socketIp) {
    headers.set('x-forwarded-for', inboundChain ? `${inboundChain}, ${socketIp}` : socketIp);
  } else if (inboundChain) {
    headers.delete('x-forwarded-for');
  }

  const normalizedTimezone = normalizeHeaderValue(timezone, 100);
  if (normalizedTimezone) {
    headers.set('x-portfolio-timezone', normalizedTimezone);
  }

  return headers;
}

export interface AdminApiSuccessEnvelope<T = unknown> {
  success: true;
  data: T;
  message?: string;
}

export interface AdminApiErrorBody {
  message: string;
  code?: string;
  details?: unknown;
}

export interface AdminApiErrorEnvelope {
  success: false;
  error: AdminApiErrorBody;
}

export type AdminApiEnvelope<T = unknown> =
  | AdminApiSuccessEnvelope<T>
  | AdminApiErrorEnvelope;

export function isSuccessEnvelope<T>(
  json: unknown,
): json is AdminApiSuccessEnvelope<T> {
  return (
    typeof json === 'object' &&
    json !== null &&
    'success' in json &&
    (json as AdminApiSuccessEnvelope).success === true &&
    'data' in json
  );
}

export { createLogger } from './logger';
export type {
  Logger,
  LogSink,
  LoggerConsole,
  CreateLoggerOptions,
} from './logger';

export { createLogShipper } from './log-shipper';
export type {
  LogShipper,
  LogShipperConsole,
  CreateLogShipperOptions,
} from './log-shipper';

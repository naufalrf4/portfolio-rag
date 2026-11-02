import type { LogEntryInput, LogLevel, LogService } from '@naufalrf/contracts';

export type LogSink = (entry: LogEntryInput) => void;

export interface LoggerConsole {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface CreateLoggerOptions {
  service: LogService;
  sink?: LogSink;
  console?: LoggerConsole;
  now?: () => Date;
  isDevelopment?: boolean;
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, error?: unknown, context?: Record<string, unknown>): void;
  request(method: string, path: string, status: number, durationMs: number): void;
  database(operation: string, table: string, durationMs: number): void;
}

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[36m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

const RESET = '\x1b[0m';

function splitContext(context: Record<string, unknown> | undefined): {
  context?: Record<string, unknown>;
  correlationId?: string;
} {
  if (!context) return {};

  const { correlationId, ...rest } = context;
  const hasRest = Object.keys(rest).length > 0;

  return {
    ...(hasRest ? { context: rest } : {}),
    ...(typeof correlationId === 'string' ? { correlationId } : {}),
  };
}

function describeError(
  error: unknown,
  includeStack: boolean,
): Pick<LogEntryInput, 'errorName' | 'errorMessage' | 'errorStack'> {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      ...(includeStack && error.stack ? { errorStack: error.stack } : {}),
    };
  }

  return {
    errorName: 'UnknownError',
    errorMessage: String(error),
  };
}

function detectDevelopment(): boolean {
  const runtime = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return runtime.process?.env?.NODE_ENV !== 'production';
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const {
    service,
    sink,
    console: out = console,
    now = () => new Date(),
    isDevelopment = detectDevelopment(),
  } = options;

  function mirror(entry: LogEntryInput): void {
    if (!isDevelopment) {
      out.log(JSON.stringify(entry));
      return;
    }

    const color = LEVEL_COLORS[entry.level];
    out.log(
      `${color}[${entry.timestamp}] ${entry.level.toUpperCase()} [${entry.service}]${RESET} ${entry.message}`,
    );

    if (entry.context) {
      out.log('  Context:', JSON.stringify(entry.context, null, 2));
    }

    if (entry.errorName) {
      out.error('  Error:', entry.errorName, '-', entry.errorMessage);
      if (entry.errorStack) {
        out.error('  Stack:', entry.errorStack);
      }
    }
  }

  function emit(entry: LogEntryInput): void {
    mirror(entry);

    if (!sink) return;

    try {
      sink(entry);
    } catch {
      // A logging sink must never break the caller. stdout above is the floor.
    }
  }

  function build(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
    extra?: Partial<LogEntryInput>,
  ): LogEntryInput {
    return {
      timestamp: now().toISOString(),
      level,
      service,
      message,
      ...splitContext(context),
      ...extra,
    };
  }

  return {
    debug(message, context) {
      if (!isDevelopment) return;
      emit(build('debug', message, context));
    },

    info(message, context) {
      emit(build('info', message, context));
    },

    warn(message, context) {
      emit(build('warn', message, context));
    },

    error(message, error, context) {
      const errorFields = error === undefined ? {} : describeError(error, isDevelopment);
      emit(build('error', message, context, errorFields));
    },

    request(method, path, status, durationMs) {
      emit(
        build('info', 'HTTP Request', { method }, { route: path, statusCode: status, durationMs }),
      );
    },

    database(operation, table, durationMs) {
      if (!isDevelopment) return;
      emit(build('debug', 'Database Operation', { operation, table }, { durationMs }));
    },
  };
}

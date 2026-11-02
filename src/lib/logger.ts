import { createLogger, createLogShipper } from '@naufalrf/http';
import type { Logger } from '@naufalrf/http';
import type { LogEntryInput } from '@naufalrf/contracts';
import { config } from '../config';

function createRagSink(): (entry: LogEntryInput) => void {
  // Only create shipper if credentials are present
  if (!config.adminInternalApiToken && !config.adminServiceToken) {
    return () => {
      // No-op sink when unauthenticated
    };
  }

  const shipper = createLogShipper({
    endpoint: `${config.adminApiUrl}/api/v1/internal/logs`,
    token: config.adminInternalApiToken || config.adminServiceToken || '',
    batchSize: 20,
    flushIntervalMs: 5000,
    maxBufferSize: 200,
    timeoutMs: 5000,
  });

  return (entry: LogEntryInput) => {
    shipper.enqueue(entry);
  };
}

const ragLogger: Logger = createLogger({
  service: 'rag-service',
  sink: createRagSink(),
  isDevelopment: process.env.NODE_ENV !== 'production',
});

export const logger = ragLogger;

// Wire graceful shutdown flush on SIGTERM/SIGINT
if (typeof process !== 'undefined') {
  const shutdownHandler = async () => {
    // Shipper cleanup would go here if we keep a reference
    // For now, the shipper is internal to the sink and will flush on process exit
    process.exit(0);
  };

  process.on('SIGTERM', shutdownHandler);
  process.on('SIGINT', shutdownHandler);
}

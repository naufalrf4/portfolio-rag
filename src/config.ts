const env = (key: string, fallback: string): string => {
  const raw = Bun.env[key];
  return raw != null && raw !== "" ? raw : fallback;
};

const envInt = (key: string, fallback: number): number => {
  const raw = env(key, "");
  return raw !== "" ? Number.parseInt(raw, 10) || fallback : fallback;
};

const envFloat = (key: string, fallback: number): number => {
  const raw = env(key, "");
  return raw !== "" ? Number.parseFloat(raw) || fallback : fallback;
};

const envBool = (key: string): boolean => {
  const raw = env(key, "false").toLowerCase();
  return raw === "true" || raw === "1";
};

export const config = {
  appEnv: env("APP_ENV", "development"),
  host: env("HOST", "0.0.0.0"),
  port: envInt("PORT", 3005),
  logLevel: env("LOG_LEVEL", "INFO"),

  databaseUrl: env(
    "RAG_DATABASE_URL",
    "postgres://postgres:postgres@localhost:5432/naufalrf_portfolio",
  ),
  adminApiUrl: env("ADMIN_API_URL", "http://localhost:3001"),
  adminServiceToken: env("ADMIN_SERVICE_TOKEN", ""),
  adminInternalApiToken: env("ADMIN_INTERNAL_API_TOKEN", ""),
  ragServiceToken: env("RAG_SERVICE_TOKEN", ""),
  ragIngestServiceToken: env("RAG_INGEST_SERVICE_TOKEN", ""),

  openaiApiKey: env("OPENAI_API_KEY", ""),
  embeddingModel: env("EMBEDDING_MODEL", "text-embedding-3-small"),
  chatModel: env("CHAT_MODEL", "gpt-4o-mini"),
  adminApiTimeoutMs: envInt("ADMIN_API_TIMEOUT_MS", 5000),

  corsOrigins: env("CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  chunkTargetTokens: envInt("CHUNK_TARGET_TOKENS", 800),
  chunkOverlapTokens: envInt("CHUNK_OVERLAP_TOKENS", 120),
  ingestionBatchSize: envInt("INGESTION_BATCH_SIZE", 32),
  retrievalLimit: envInt("RETRIEVAL_LIMIT", 5),
  chatHistoryLimit: envInt("CHAT_HISTORY_LIMIT", 6),
  isProduction: env("APP_ENV", "development").toLowerCase() === "production",
} as const;

if (config.chunkOverlapTokens >= config.chunkTargetTokens) {
  throw new Error(
    `Invalid chunk config: CHUNK_OVERLAP_TOKENS (${config.chunkOverlapTokens}) must be less than ` +
      `CHUNK_TARGET_TOKENS (${config.chunkTargetTokens}) or paragraph splitting never advances.`,
  );
}

import { sql } from "./db";
import { config } from "./config";
import { logger } from "./lib/logger";

async function bootstrap(): Promise<void> {
  logger.info("[bootstrap] Checking database connectivity...");

  try {
    const results = await sql`
      SELECT EXISTS (
        SELECT FROM information_schema.schemata WHERE schema_name = 'rag'
      ) AS rag_schema_exists
    `;
    const schemaExists = results[0]?.rag_schema_exists === true;

    if (!schemaExists) {
      logger.info("[bootstrap] Creating rag schema...");
      await sql.unsafe("CREATE SCHEMA IF NOT EXISTS rag");
      logger.info("[bootstrap] rag schema created.");
    } else {
      logger.info("[bootstrap] rag schema already exists.");
    }

    await sql.unsafe("CREATE EXTENSION IF NOT EXISTS vector");
    logger.info("[bootstrap] vector extension ready.");

    const tableCheck = await sql`
      SELECT tablename FROM pg_catalog.pg_tables
      WHERE schemaname = 'rag'
        AND tablename IN ('documents', 'chunks', 'ingestion_runs')
    `;
    const found = tableCheck.map((r) => r.tablename as string);
    logger.info(`[bootstrap] Found rag tables: ${found.join(", ") || "none"}`);

    if (found.length < 3) {
      logger.warn(
        "[bootstrap] Some rag tables are missing. Admin owns schema migrations. " +
          "Run Admin Drizzle migrations first, then re-run bootstrap.",
      );
    }

    logger.info(`[bootstrap] Connected to: ${config.databaseUrl.replace(/\/\/.*@/, "//***@")}`);
    logger.info("[bootstrap] Database bootstrap complete.");

    await sql.end();
    process.exit(0);
  } catch (err) {
    logger.error("[bootstrap] Database bootstrap failed", err);
    await sql.end().catch(() => {});
    process.exit(1);
  }
}

bootstrap();

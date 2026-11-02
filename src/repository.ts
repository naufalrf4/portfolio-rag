import { sql } from "./db";
import type { ChunkWritePayload, RetrievedChunk } from "./types";

function formatEmbedding(values: number[]): string {
  return `[${values.join(",")}]`;
}

function asJsonValue(value: Record<string, unknown>): Record<string, string | number | boolean | null> {
  return value as Record<string, string | number | boolean | null>;
}

function asMetadataObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
    }
  }
  return {};
}

export function mergeRetrievedChunks(
  denseResults: RetrievedChunk[],
  lexicalResults: RetrievedChunk[],
  limit: number,
): RetrievedChunk[] {
  const merged = new Map<string, RetrievedChunk>();
  const maxLexicalScore = lexicalResults.reduce(
    (max, c) => Math.max(max, c.lexicalScore),
    0,
  );

  for (const chunk of denseResults) {
    const key = `${chunk.source}::${chunk.content}`;
    merged.set(key, {
      source: chunk.source,
      content: chunk.content,
      score: chunk.denseScore,
      metadata: { ...chunk.metadata },
      denseScore: chunk.denseScore,
      lexicalScore: 0,
      matchReasons: ["dense"],
    });
  }

  for (const chunk of lexicalResults) {
    const key = `${chunk.source}::${chunk.content}`;
    const normalizedLexical = maxLexicalScore > 0 ? chunk.lexicalScore / maxLexicalScore : 0;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        source: chunk.source,
        content: chunk.content,
        score: normalizedLexical,
        metadata: { ...chunk.metadata },
        denseScore: 0,
        lexicalScore: normalizedLexical,
        matchReasons: ["lexical"],
      });
      continue;
    }
    existing.lexicalScore = Math.max(existing.lexicalScore, normalizedLexical);
    if (!existing.matchReasons.includes("lexical")) {
      existing.matchReasons.push("lexical");
    }
  }

  for (const chunk of merged.values()) {
    chunk.score = Math.min(1, chunk.denseScore * 0.7 + chunk.lexicalScore * 0.3);
  }

  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

interface DocRow {
  id: string;
  source_type: string;
  source_ref: string;
  title: string;
  visibility: string;
  sensitivity: string;
  storage_key: string | null;
  mime_type: string | null;
  status: string;
  tags: string[];
  metadata: Record<string, unknown>;
  content_hash: string | null;
  content_excerpt: string | null;
  last_ingested_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function upsertDocument(params: {
  sourceType: string;
  sourceRef: string;
  title: string;
  visibility: string;
  sensitivity: string;
  storageKey: string | null;
  mimeType: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  contentHash: string | null;
  contentExcerpt: string | null;
}): Promise<DocRow> {
  const existing = await sql<DocRow[]>`
    SELECT id FROM rag.documents
    WHERE source_type = ${params.sourceType} AND source_ref = ${params.sourceRef}
  `;

  if (existing.length === 0) {
    const rows = await sql<DocRow[]>`
      INSERT INTO rag.documents (
        source_type, source_ref, title, visibility, sensitivity,
        storage_key, mime_type, tags, metadata, content_hash, content_excerpt, status
      ) VALUES (
        ${params.sourceType}, ${params.sourceRef}, ${params.title},
        ${params.visibility}, ${params.sensitivity},
        ${params.storageKey}, ${params.mimeType},
        ${sql.json(params.tags)}, ${sql.json(params.metadata as Record<string, string | number | boolean | null>)},
        ${params.contentHash}, ${params.contentExcerpt}, 'ready'
      ) RETURNING *
    `;
    return rows[0]!;
  }

  const docId = existing[0]!.id;
  const rows = await sql<DocRow[]>`
    UPDATE rag.documents SET
      title = ${params.title},
      visibility = ${params.visibility},
      sensitivity = ${params.sensitivity},
      storage_key = ${params.storageKey},
      mime_type = ${params.mimeType},
      tags = ${sql.json(params.tags)},
      metadata = ${sql.json(params.metadata as Record<string, string | number | boolean | null>)},
      content_hash = ${params.contentHash},
      content_excerpt = ${params.contentExcerpt},
      updated_at = now()
    WHERE id = ${docId}
    RETURNING *
  `;
  return rows[0]!;
}

export async function replaceChunks(
  documentId: string,
  chunks: ChunkWritePayload[],
): Promise<void> {
  await sql`DELETE FROM rag.chunks WHERE document_id = ${documentId}`;

  for (const chunk of chunks) {
    if (chunk.embedding.length === 0) {
      throw new Error(
        `replaceChunks: chunk ${chunk.chunkIndex} for document ${documentId} has an empty embedding`,
      );
    }
    const embStr = formatEmbedding(chunk.embedding);
    const metadataValue = asJsonValue(chunk.metadata);
    await sql.unsafe(
      `INSERT INTO rag.chunks (
        id, document_id, chunk_index, source_type, source_ref,
        visibility, content, contextual_content, token_count, checksum, metadata, embedding, created_at
      ) VALUES (
        gen_random_uuid(), $1, $2,
        $3, $4, $5,
        $6, $7, $8,
        $9, $10::jsonb, $11::vector, now()
      )`,
      [
        documentId,
        chunk.chunkIndex,
        chunk.sourceType,
        chunk.sourceRef,
        chunk.visibility,
        chunk.content,
        chunk.content,
        chunk.tokenCount,
        chunk.checksum,
        metadataValue,
        embStr,
      ],
    );
  }

  await sql`
    UPDATE rag.documents SET status = 'ready', last_ingested_at = now()
    WHERE id = ${documentId}
  `;
}

export async function createIngestionRun(
  triggerType: string,
  requestPayload: Record<string, unknown>,
): Promise<{ id: string }> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO rag.ingestion_runs (trigger_type, request_payload, status)
    VALUES (${triggerType}, ${sql.json(requestPayload as never)}, 'pending')
    RETURNING id
  `;
  return rows[0]!;
}

export async function updateIngestionRun(
  runId: string,
  updates: {
    status: string;
    documentId?: string | null;
    chunksWritten?: number | null;
    errorMessage?: string | null;
  },
): Promise<void> {
  const setClauses: string[] = [];
  const vals: unknown[] = [];
  let idx = 1;

  setClauses.push(`status = $${idx++}`);
  vals.push(updates.status);

  if (updates.documentId !== undefined) {
    setClauses.push(`document_id = $${idx++}`);
    vals.push(updates.documentId);
  }
  if (updates.chunksWritten !== undefined) {
    setClauses.push(`chunks_written = $${idx++}`);
    vals.push(updates.chunksWritten);
  }
  if (updates.errorMessage !== undefined) {
    setClauses.push(`error_message = $${idx++}`);
    vals.push(updates.errorMessage);
  }

  if (["completed", "partial", "failed"].includes(updates.status)) {
    setClauses.push(`completed_at = now()`);
  }

  vals.push(runId);
  await sql.unsafe(
    `UPDATE rag.ingestion_runs SET ${setClauses.join(", ")} WHERE id = $${idx}`,
    vals as never[],
  );
}

export async function searchChunksHybrid(
  queryEmbedding: number[],
  queryText: string,
  limit: number,
  visibilities: string[],
): Promise<RetrievedChunk[]> {
  if (limit <= 0) {
    throw new Error(`searchChunksHybrid: limit must be a positive integer, got ${limit}`);
  }
  const candidateLimit = Math.max(limit * 3, limit);
  const denseResults = await searchChunksDense(queryEmbedding, candidateLimit, visibilities);
  const lexicalResults = await searchChunksLexical(queryText, candidateLimit, visibilities);
  return mergeRetrievedChunks(denseResults, lexicalResults, limit);
}

async function searchChunksDense(
  queryEmbedding: number[],
  limit: number,
  visibilities: string[],
): Promise<RetrievedChunk[]> {
  if (limit <= 0) {
    throw new Error(`searchChunksDense: limit must be a positive integer, got ${limit}`);
  }
  const embStr = formatEmbedding(queryEmbedding);
  const rows = await sql.unsafe(
    `
    SELECT
      c.source_type, c.source_ref, c.content, c.metadata,
      1 - (c.embedding <=> $1::vector) AS dense_score
    FROM rag.chunks c
    JOIN rag.documents d ON c.document_id = d.id
    WHERE c.visibility = ANY($2::text[]) AND d.status = 'ready'
    ORDER BY c.embedding <=> $1::vector
    LIMIT $3
  `,
    [embStr, visibilities, limit],
  );

  return rows.map((row: Record<string, unknown>) => {
    const metadata = asMetadataObject(row.metadata);
    const denseScore = Math.max(0, Number(row.dense_score) || 0);
    return {
      source: String(
        metadata.source_label ?? `${row.source_type}:${row.source_ref}`,
      ),
      content: String(row.content ?? ""),
      score: denseScore,
      metadata,
      denseScore,
      lexicalScore: 0,
      matchReasons: ["dense"],
    };
  });
}

async function searchChunksLexical(
  queryText: string,
  limit: number,
  visibilities: string[],
): Promise<RetrievedChunk[]> {
  const normalized = queryText.trim();
  if (!normalized) return [];

  const rows = await sql.unsafe(
    `
    SELECT
      c.source_type, c.source_ref, c.content, c.metadata,
      ts_rank_cd(
        to_tsvector('simple', coalesce(c.content, '')),
        websearch_to_tsquery('simple', $1)
      ) AS lexical_rank
    FROM rag.chunks c
    JOIN rag.documents d ON c.document_id = d.id
    WHERE
      c.visibility = ANY($2::text[])
      AND d.status = 'ready'
      AND to_tsvector('simple', coalesce(c.content, '')) @@ websearch_to_tsquery('simple', $1)
    ORDER BY lexical_rank DESC
    LIMIT $3
  `,
    [normalized, visibilities, limit],
  );

  return rows.map((row: Record<string, unknown>) => {
    const metadata = asMetadataObject(row.metadata);
    const lexicalScore = Math.max(0, Number(row.lexical_rank) || 0);
    return {
      source: String(
        metadata.source_label ?? `${row.source_type}:${row.source_ref}`,
      ),
      content: String(row.content ?? ""),
      score: lexicalScore,
      metadata,
      denseScore: 0,
      lexicalScore,
      matchReasons: ["lexical"],
    };
  });
}

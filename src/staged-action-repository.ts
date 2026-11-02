import { sql } from "./db";
import type { PendingAction } from "./types";

const STAGED_ACTION_TTL_MS = 10 * 60 * 1000;

export interface StagedAction {
  id: string;
  sessionId: string;
  tool: string;
  payload: Record<string, unknown>;
  description: string;
}

export async function stageAction(
  sessionId: string,
  action: PendingAction,
): Promise<string> {
  const expiresAt = new Date(Date.now() + STAGED_ACTION_TTL_MS).toISOString();
  const rows = await sql`
    INSERT INTO rag.staged_actions (session_id, tool, payload, description, expires_at)
    VALUES (${sessionId}, ${action.tool}, ${sql.json(action.payload as Record<string, string | number | boolean | null>)}, ${action.description}, ${expiresAt})
    RETURNING id
  `;
  return rows[0]?.id as string;
}

export async function findActiveAction(
  sessionId: string,
  tool: string,
): Promise<StagedAction | null> {
  const rows = await sql`
    SELECT id, session_id, tool, payload, description
    FROM rag.staged_actions
    WHERE session_id = ${sessionId}
      AND tool = ${tool}
      AND consumed_at IS NULL
      AND expires_at > CURRENT_TIMESTAMP
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    tool: row.tool as string,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    description: row.description as string,
  };
}

export async function updateStagedAction(
  actionId: string,
  sessionId: string,
  action: PendingAction,
): Promise<string | null> {
  const expiresAt = new Date(Date.now() + STAGED_ACTION_TTL_MS).toISOString();
  const rows = await sql`
    UPDATE rag.staged_actions
    SET payload = ${sql.json(action.payload as Record<string, string | number | boolean | null>)},
        description = ${action.description},
        expires_at = ${expiresAt}
    WHERE id = ${actionId}
      AND session_id = ${sessionId}
      AND consumed_at IS NULL
      AND expires_at > CURRENT_TIMESTAMP
    RETURNING id
  `;
  return (rows[0]?.id as string) ?? null;
}

export async function consumeAction(
  actionId: string,
  sessionId: string,
): Promise<StagedAction | null> {
  const rows = await sql`
    UPDATE rag.staged_actions
    SET consumed_at = CURRENT_TIMESTAMP
    WHERE id = ${actionId}
      AND session_id = ${sessionId}
      AND consumed_at IS NULL
      AND expires_at > CURRENT_TIMESTAMP
    RETURNING id, session_id, tool, payload, description
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    tool: row.tool as string,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    description: row.description as string,
  };
}

export async function deleteExpiredActions(): Promise<number> {
  const rows = await sql`
    DELETE FROM rag.staged_actions
    WHERE expires_at <= CURRENT_TIMESTAMP OR consumed_at IS NOT NULL
    RETURNING id
  `;
  return rows.length;
}

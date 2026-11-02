import { config } from "./config";
import { RagServiceError } from "./errors";
import type { ChatLogMessage, ContentExport, FreelanceProfile } from "./types";

function internalToken(): string {
  const token = config.adminInternalApiToken || config.adminServiceToken;
  if (!token) {
    throw new RagServiceError(
      "ADMIN_INTERNAL_API_TOKEN is not configured.",
      "ADMIN_INTERNAL_API_TOKEN_NOT_CONFIGURED",
      503,
    );
  }
  return token;
}

async function adminRequest<T>(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const url = `${config.adminApiUrl.replace(/\/$/, "")}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.adminApiTimeoutMs);
  try {
    const fetchOptions: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Service-Token": internalToken(),
      },
      signal: controller.signal,
    };
    if (body) {
      fetchOptions.body = JSON.stringify(body);
    }
    const res = await fetch(url, fetchOptions);
    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = payload.error as { message?: string; code?: string } | undefined;
      throw new RagServiceError(
        typeof err?.message === "string"
          ? err.message
          : `Admin API returned ${res.status} for ${path}.`,
        typeof err?.code === "string" ? err.code : "ADMIN_API_ERROR",
        res.status,
      );
    }
    return ((payload.data ?? payload) as unknown) as T;
  } catch (err) {
    if (err instanceof RagServiceError) throw err;
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new RagServiceError(
        `Admin API request timed out for ${path}.`,
        "ADMIN_API_TIMEOUT",
        504,
      );
    }
    throw new RagServiceError(
      `Admin API request failed for ${path}.`,
      "ADMIN_API_UNAVAILABLE",
      502,
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function getContentExport(): Promise<ContentExport> {
  return adminRequest<ContentExport>("GET", "/api/v1/internal/content");
}

export async function getFreelanceIntentContext(): Promise<{
  freelanceProfile: FreelanceProfile | null;
}> {
  return adminRequest<{ freelanceProfile: FreelanceProfile | null }>(
    "GET",
    "/api/v1/internal/intent-context/freelance-profile",
  );
}

export async function getKnowledgeDocById(
  documentId: string,
): Promise<{ id: string; filename: string; content: string; indexed: boolean }> {
  return adminRequest("GET", `/api/v1/internal/knowledge/${documentId}`);
}

export async function markKnowledgeDocIndexed(documentId: string): Promise<void> {
  await adminRequest("PATCH", `/api/v1/internal/knowledge/${documentId}/indexed`);
}

export async function getChatLog(sessionId: string): Promise<ChatLogMessage[]> {
  const payload = (await adminRequest<Record<string, unknown>>(
    "GET",
    `/api/v1/internal/chat-logs?sessionId=${encodeURIComponent(sessionId)}`,
  ));
  if (!payload || Object.keys(payload as Record<string, never>).length === 0) return [];
  return (payload as { messages: ChatLogMessage[] }).messages ?? [];
}

export async function saveChatLog(
  sessionId: string,
  messages: Array<Record<string, unknown>>,
  mode: string = "replace",
): Promise<void> {
  await adminRequest("POST", "/api/v1/internal/chat-logs", {
    sessionId,
    messages,
    mode,
  });
}

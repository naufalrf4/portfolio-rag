import { logger } from "./lib/logger";
import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { config } from "./config";
import { consumeAction } from "./staged-action-repository";
import type { ChatRequest, ConfirmRequest, ConfirmResponse, IngestRequest, IngestResponse } from "./types";
import { chat } from "./chat-service";
import { ingest } from "./ingest-service";
import { RagServiceError } from "./errors";
import { executeSubmitGuestbook, executeSendMessage, executeCreateBooking } from "./agentic-tools";
import { checkRateLimit, getRateLimitHeaders } from "./rate-limiter";

const app = new Hono();

const MAX_CHAT_MESSAGE_LENGTH = 2000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CHAT_RATE_LIMIT_CONFIG = { maxRequests: 20, windowMs: 60 * 1000 };
const CHAT_CONFIRM_RATE_LIMIT_CONFIG = { maxRequests: 6, windowMs: 60 * 1000 };

function getClientIp(c: Context): string {
  const forwarded = c.req.header("X-Forwarded-For");
  if (forwarded) {
    const hops = forwarded
      .split(",")
      .map((segment) => segment.trim())
      .filter(Boolean);
    const trusted = hops[hops.length - 1];
    if (trusted) return trusted;
  }

  const realIp = c.req.header("X-Real-IP")?.trim();
  if (realIp) return realIp;

  return "unknown";
}

function rateLimitedResponse(c: Context, message: string, headers: Record<string, string>) {
  return c.json(
    {
      success: false,
      error: { message, code: "RATE_LIMITED" },
    },
    429,
    headers,
  );
}

function unauthorizedServiceResponse(c: Context) {
  return c.json(
    {
      success: false,
      error: { message: "Unauthorized.", code: "UNAUTHORIZED" },
    },
    401,
  );
}

app.use(
  "*",
  cors({
    origin: config.corsOrigins,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "Accept-Language",
      "X-Service-Token",
    ],
    maxAge: 600,
  }),
);

function serviceTokenValid(token: string | null): boolean {
  if (!token) return false;
  const expected = config.ragIngestServiceToken || config.adminServiceToken;
  if (expected === "") return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

app.get("/health", (c) => {
  return c.json({ status: "ok" });
});

app.post("/chat", async (c) => {
  if (!serviceTokenValid(c.req.header("X-Service-Token") ?? null)) {
    return unauthorizedServiceResponse(c);
  }

  const clientIp = getClientIp(c);
  const ipRateLimit = checkRateLimit(`chat:ip:${clientIp}`, CHAT_RATE_LIMIT_CONFIG);
  if (!ipRateLimit.allowed) {
    return rateLimitedResponse(
      c,
      "Too many chat requests. Please wait a minute before trying again.",
      getRateLimitHeaders(ipRateLimit),
    );
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new RagServiceError(
      "Invalid JSON body.",
      "INVALID_CHAT_REQUEST",
      400,
    );
  }

  const raw = body as Record<string, unknown>;
  const chatRequest: ChatRequest = {
    message: typeof raw.message === "string" ? raw.message.trim() : "",
  };
  if (typeof raw.sessionId === "string" && UUID_PATTERN.test(raw.sessionId)) {
    chatRequest.sessionId = raw.sessionId;
  }

  if (chatRequest.sessionId) {
    const sessionRateLimit = checkRateLimit(
      `chat:session:${chatRequest.sessionId}`,
      CHAT_RATE_LIMIT_CONFIG,
    );
    if (!sessionRateLimit.allowed) {
      return rateLimitedResponse(
        c,
        "Too many chat requests. Please wait a minute before trying again.",
        getRateLimitHeaders(sessionRateLimit),
      );
    }
  }

  if (!chatRequest.message) {
    throw new RagServiceError(
      "message is required.",
      "INVALID_CHAT_REQUEST",
      400,
    );
  }

  if (chatRequest.message.length > MAX_CHAT_MESSAGE_LENGTH) {
    throw new RagServiceError(
      `message must be ${MAX_CHAT_MESSAGE_LENGTH} characters or less.`,
      "INVALID_CHAT_REQUEST",
      400,
    );
  }

  const preferredLanguage = c.req.header("Accept-Language") ?? undefined;
  const response = await chat(chatRequest, preferredLanguage);
  return c.json(response);
});

app.post("/chat/confirm", async (c) => {
  if (!serviceTokenValid(c.req.header("X-Service-Token") ?? null)) {
    return unauthorizedServiceResponse(c);
  }

  const clientIp = getClientIp(c);
  const ipRateLimit = checkRateLimit(`chat-confirm:ip:${clientIp}`, CHAT_CONFIRM_RATE_LIMIT_CONFIG);
  if (!ipRateLimit.allowed) {
    return rateLimitedResponse(
      c,
      "Too many confirmation requests. Please wait a minute before trying again.",
      getRateLimitHeaders(ipRateLimit),
    );
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new RagServiceError("Invalid JSON body.", "INVALID_CONFIRM_REQUEST", 400);
  }

  const raw = body as Record<string, unknown>;
  const actionId = typeof raw.actionId === "string" ? raw.actionId : "";
  const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : "";
  const confirm = Boolean(raw.confirm);

  if (!UUID_PATTERN.test(actionId)) {
    throw new RagServiceError("actionId is required.", "INVALID_CONFIRM_REQUEST", 400);
  }

  if (!UUID_PATTERN.test(sessionId)) {
    throw new RagServiceError("sessionId is required.", "INVALID_CONFIRM_REQUEST", 400);
  }

  const sessionRateLimit = checkRateLimit(
    `chat-confirm:session:${sessionId}`,
    CHAT_CONFIRM_RATE_LIMIT_CONFIG,
  );
  if (!sessionRateLimit.allowed) {
    return rateLimitedResponse(
      c,
      "Too many confirmation requests. Please wait a minute before trying again.",
      getRateLimitHeaders(sessionRateLimit),
    );
  }

  const staged = await consumeAction(actionId, sessionId);

  if (!confirm) {
    const response: ConfirmResponse = {
      success: true,
      message: "Action cancelled.",
    };
    return c.json(response);
  }

  if (staged === null) {
    throw new RagServiceError(
      "This action is no longer available. Please ask again.",
      "STAGED_ACTION_UNAVAILABLE",
      409,
    );
  }

  const adminApiUrl = config.adminApiUrl;
  const forwardedIp = clientIp !== "unknown" ? clientIp : undefined;

  let result: { success: boolean; message: string };
  if (staged.tool === "submit_guestbook") {
    result = await executeSubmitGuestbook(staged.payload, adminApiUrl, forwardedIp);
  } else if (staged.tool === "send_message") {
    result = await executeSendMessage(staged.payload, adminApiUrl, forwardedIp);
  } else if (staged.tool === "create_booking") {
    result = await executeCreateBooking(staged.payload, adminApiUrl, forwardedIp);
  } else {
    throw new RagServiceError(`Unknown tool: ${staged.tool}`, "UNKNOWN_TOOL", 400);
  }

  const response: ConfirmResponse = result;
  return c.json(response);
});

app.post("/ingest", async (c) => {
  const token = c.req.header("X-Service-Token") ?? null;
  if (!serviceTokenValid(token)) {
    return unauthorizedServiceResponse(c);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new RagServiceError(
      "Invalid JSON body.",
      "INVALID_INGEST_REQUEST",
      400,
    );
  }

  const raw = body as Record<string, unknown>;
  const type = String(raw.type ?? "all");
  if (!["knowledge", "project", "blog", "about", "all"].includes(type)) {
    throw new RagServiceError(
      `Invalid ingest type "${type}".`,
      "INVALID_INGEST_REQUEST",
      400,
    );
  }

  const ingestRequest: IngestRequest = {
    type: type as IngestRequest["type"],
  };
  if (typeof raw.documentId === "string") {
    ingestRequest.documentId = raw.documentId;
  }

  if (
    (ingestRequest.type === "knowledge" ||
      ingestRequest.type === "project" ||
      ingestRequest.type === "blog") &&
    !ingestRequest.documentId
  ) {
    throw new RagServiceError(
      `documentId is required for type "${ingestRequest.type}".`,
      "INVALID_INGEST_REQUEST",
      400,
    );
  }

  const result: IngestResponse = await ingest(ingestRequest);
  return c.json({ success: true, data: result });
});

app.onError((err, c) => {
  logger.error("RAG service error", err);
  if (err instanceof RagServiceError) {
    return c.json(
      {
        success: false,
        error: { message: err.message, code: err.code },
      },
      err.statusCode as never,
    );
  }
  return c.json(
    {
      success: false,
      error: {
        message: "Internal server error.",
        code: "INTERNAL_ERROR",
      },
    },
    500,
  );
});

export default {
  port: config.port,
  hostname: config.host,
  fetch: app.fetch,
};

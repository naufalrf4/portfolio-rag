import { logger } from "./lib/logger";
import { config } from "./config";
import { RagServiceError } from "./errors";
import type { FullLlmConfig, LlmSlotConfig } from "./llm-provider";

interface AdminLlmConfigResponse {
  main: {
    provider: string;
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  fallback: {
    provider: string;
    baseUrl: string;
    apiKey: string;
    model: string;
  } | null;
  embedding: {
    provider: string;
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  embeddingDimension: number;
}

let cached: AdminLlmConfigResponse | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 10_000;
let fetchInFlight: Promise<AdminLlmConfigResponse> | null = null;

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

export async function fetchLlmConfigFromAdmin(): Promise<AdminLlmConfigResponse> {
  const now = Date.now();
  if (cached !== null && now - cacheTime < CACHE_TTL_MS) {
    return cached;
  }

  if (fetchInFlight !== null) {
    return fetchInFlight;
  }
  fetchInFlight = doFetchLlmConfigFromAdmin(now);
  try {
    return await fetchInFlight;
  } finally {
    fetchInFlight = null;
  }
}

async function doFetchLlmConfigFromAdmin(
  now: number,
): Promise<AdminLlmConfigResponse> {
  const url = `${config.adminApiUrl.replace(/\/$/, "")}/api/v1/internal/llm-config`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.adminApiTimeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Service-Token": internalToken(),
      },
      signal: controller.signal,
    });

    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;

    if (!res.ok) {
      throw new RagServiceError(
        `Admin LLM config request failed: ${res.status}`,
        "ADMIN_LLM_CONFIG_ERROR",
        502,
      );
    }

    const data = (payload.data ?? payload) as AdminLlmConfigResponse | null;

    if (!data || !data.main) {
      cached = null as never;
      cacheTime = 0;
      throw new RagServiceError(
        "Admin LLM config is not available.",
        "ADMIN_LLM_CONFIG_NOT_FOUND",
        502,
      );
    }

    cached = data;
    cacheTime = now;
    return data;
  } catch (err) {
    if (err instanceof RagServiceError) throw err;
    throw new RagServiceError(
      `Admin LLM config request failed: ${String(err)}`,
      "ADMIN_LLM_CONFIG_UNAVAILABLE",
      502,
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveLlmConfig(): Promise<FullLlmConfig> {
  try {
    const admin = await fetchLlmConfigFromAdmin();
    const main: LlmSlotConfig = {
      provider: admin.main.provider as LlmSlotConfig["provider"],
      baseUrl: admin.main.baseUrl,
      apiKey: admin.main.apiKey,
      model: admin.main.model,
    };
    const fallback = admin.fallback
      ? ({
          provider: admin.fallback.provider as LlmSlotConfig["provider"],
          baseUrl: admin.fallback.baseUrl,
          apiKey: admin.fallback.apiKey,
          model: admin.fallback.model,
        } as LlmSlotConfig)
      : undefined;
    const embedding: LlmSlotConfig = {
      provider: admin.embedding.provider as LlmSlotConfig["provider"],
      baseUrl: admin.embedding.baseUrl,
      apiKey: admin.embedding.apiKey,
      model: admin.embedding.model,
      ...(admin.embeddingDimension ? { dimensions: admin.embeddingDimension } : {}),
    };
    const result: FullLlmConfig = { main, embedding };
    if (fallback !== undefined) {
      result.fallback = fallback;
    }
    return result;
  } catch (err) {
    logger.warn(
      `[LLM Config] Admin API unavailable (${String(err)}), falling back to env vars.`,
    );
    return buildEnvFallbackConfig();
  }
}

function buildEnvFallbackConfig(): FullLlmConfig {
  if (!config.openaiApiKey) {
    throw new RagServiceError(
      "No LLM API key configured (neither Admin config nor env).",
      "LLM_API_KEY_NOT_CONFIGURED",
      503,
    );
  }
  return {
    main: {
      provider: "openai-compatible",
      baseUrl: "https://api.openai.com",
      apiKey: config.openaiApiKey,
      model: config.chatModel,
    },
    embedding: {
      provider: "openai-compatible",
      baseUrl: "https://api.openai.com",
      apiKey: config.openaiApiKey,
      model: config.embeddingModel,
    },
  };
}

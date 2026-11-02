import { logger } from "./lib/logger";
import { RagServiceError } from "./errors";

export type ProviderType = "openai-compatible" | "gemini";

export interface LlmSlotConfig {
  provider: ProviderType;
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions?: number;
}

export interface FullLlmConfig {
  main: LlmSlotConfig;
  fallback?: LlmSlotConfig;
  embedding: LlmSlotConfig;
}

export interface GenerateResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
}

export interface LlmClient {
  generate(prompt: string, temperature?: number): Promise<GenerateResult>;
  embed(texts: string[]): Promise<number[][]>;
}

class OpenAiCompatibleClient implements LlmClient {
  constructor(private readonly config: LlmSlotConfig) {}

  async generate(prompt: string, temperature = 0.2): Promise<GenerateResult> {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [{ role: "user", content: prompt }],
          temperature,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new RagServiceError(
          `0penAI-compatible API error (${res.status}): ${errBody.slice(0, 300)}`,
          "LLM_PROVIDER_ERROR",
          502,
        );
      }
      const data = (await res.json()) as Record<string, unknown>;
      const choices = data.choices as Array<{ message?: { content?: string } }> | undefined;
      const text = choices?.[0]?.message?.content?.trim() ?? "";
      if (!text) {
        throw new RagServiceError("LLM response was empty.", "LLM_RESPONSE_EMPTY", 502);
      }
      const usage = data.usage as
        | { prompt_tokens?: number; completion_tokens?: number }
        | undefined;
      return {
        text,
        promptTokens: usage?.prompt_tokens ?? 0,
        completionTokens: usage?.completion_tokens ?? 0,
      };
    } catch (err) {
      if (err instanceof RagServiceError) throw err;
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new RagServiceError("LLM provider timed out.", "LLM_PROVIDER_TIMEOUT", 504);
      }
      throw new RagServiceError(
        `LLM provider request failed: ${String(err)}`,
        "LLM_PROVIDER_UNAVAILABLE",
        502,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/v1/embeddings`;
    const all: number[][] = [];
    const batchSize = 32;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify({
            model: this.config.model,
            input: batch,
            ...(this.config.dimensions ? { dimensions: this.config.dimensions } : {}),
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const errBody = await res.text().catch(() => "");
          throw new RagServiceError(
            `Embedding API error (${res.status}): ${errBody.slice(0, 300)}`,
            "EMBEDDING_API_ERROR",
            502,
          );
        }
        const data = (await res.json()) as Record<string, unknown>;
        const items = data.data as Array<{ embedding: number[] }> | undefined;
        if (!items || !Array.isArray(items)) {
          throw new RagServiceError(
            "Embedding response did not contain vectors.",
            "EMBEDDING_RESPONSE_INVALID",
            502,
          );
        }
        for (const item of items) {
          all.push(item.embedding);
        }
      }
      return all;
    } catch (err) {
      if (err instanceof RagServiceError) throw err;
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new RagServiceError("Embedding provider timed out.", "EMBEDDING_PROVIDER_TIMEOUT", 504);
      }
      throw new RagServiceError(
        `Embedding provider request failed: ${String(err)}`,
        "EMBEDDING_PROVIDER_UNAVAILABLE",
        502,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

class GeminiClient implements LlmClient {
  constructor(private readonly config: LlmSlotConfig) {}

  private get effectiveBaseUrl(): string {
    if (this.config.baseUrl) {
      return this.config.baseUrl.replace(/\/$/, "");
    }
    return "https://generativelanguage.googleapis.com/v1beta";
  }

  async generate(prompt: string, temperature = 0.2): Promise<GenerateResult> {
    const modelId = this.config.model.startsWith("models/")
      ? this.config.model
      : `models/${this.config.model}`;
    const url = `${this.effectiveBaseUrl}/${modelId}:generateContent?key=${encodeURIComponent(this.config.apiKey)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature },
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new RagServiceError(
          `Gem1ni API error (${res.status}): ${errBody.slice(0, 300)}`,
          "LLM_PROVIDER_ERROR",
          502,
        );
      }
      const data = (await res.json()) as Record<string, unknown>;
      const candidates = data.candidates as Array<{
        content?: { parts?: Array<{ text?: string }> };
      }> | undefined;
      const text =
        candidates?.[0]?.content?.parts
          ?.map((p) => p.text ?? "")
          .join("")
          .trim() ?? "";
      if (!text) {
        throw new RagServiceError("LLM response was empty.", "LLM_RESPONSE_EMPTY", 502);
      }
      const usage = data.usageMetadata as
        | { promptTokenCount?: number; candidatesTokenCount?: number }
        | undefined;
      return {
        text,
        promptTokens: usage?.promptTokenCount ?? 0,
        completionTokens: usage?.candidatesTokenCount ?? 0,
      };
    } catch (err) {
      if (err instanceof RagServiceError) throw err;
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new RagServiceError("LLM provider timed out.", "LLM_PROVIDER_TIMEOUT", 504);
      }
      throw new RagServiceError(
        `LLM provider request failed: ${String(err)}`,
        "LLM_PROVIDER_UNAVAILABLE",
        502,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const modelId = this.config.model.startsWith("models/")
      ? this.config.model
      : `models/${this.config.model}`;
    const all: number[][] = [];
    const batchSize = 32;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const url = `${this.effectiveBaseUrl}/${modelId}:batchEmbedContents?key=${encodeURIComponent(this.config.apiKey)}`;
        const payload = {
          requests: batch.map((text) => ({
            model: modelId,
            content: { parts: [{ text }] },
          })),
        };
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        if (!res.ok) {
          const errBody = await res.text().catch(() => "");
          throw new RagServiceError(
            `Embedding API error (${res.status}): ${errBody.slice(0, 300)}`,
            "EMBEDDING_API_ERROR",
            502,
          );
        }
        const data = (await res.json()) as Record<string, unknown>;
        const embeddings = data.embeddings as Array<{ values: number[] }> | undefined;
        if (!embeddings || !Array.isArray(embeddings)) {
          throw new RagServiceError(
            "Embedding response did not contain vectors.",
            "EMBEDDING_RESPONSE_INVALID",
            502,
          );
        }
        for (const emb of embeddings) {
          all.push(emb.values);
        }
      }
      return all;
    } catch (err) {
      if (err instanceof RagServiceError) throw err;
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new RagServiceError("Embedding provider timed out.", "EMBEDDING_PROVIDER_TIMEOUT", 504);
      }
      throw new RagServiceError(
        `Embedding provider request failed: ${String(err)}`,
        "EMBEDDING_PROVIDER_UNAVAILABLE",
        502,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createLlmClient(slot: LlmSlotConfig): LlmClient {
  if (slot.provider === "gemini") {
    return new GeminiClient(slot);
  }
  return new OpenAiCompatibleClient(slot);
}

export class LlmProvider {
  public readonly main: LlmClient;
  public readonly fallback: LlmClient | null;
  public readonly embedding: LlmClient;

  constructor(config: FullLlmConfig) {
    this.main = createLlmClient(config.main);
    this.fallback = config.fallback ? createLlmClient(config.fallback) : null;
    this.embedding = createLlmClient(config.embedding);
  }

  async generate(prompt: string, temperature = 0.2): Promise<GenerateResult> {
    try {
      return await this.main.generate(prompt, temperature);
    } catch (mainErr) {
      if (!this.fallback) throw mainErr;
      logger.warn(
        `[LLM] Main provider failed (${String(mainErr)}), falling back.`,
      );
      try {
        return await this.fallback.generate(prompt, temperature);
      } catch (fallbackErr) {
        if (fallbackErr instanceof Error) {
          (fallbackErr as Error & { cause?: unknown }).cause = mainErr;
        }
        logger.error(
          `[LLM] Fallback provider also failed (${String(fallbackErr)}); main provider error was (${String(mainErr)}).`,
        );
        throw fallbackErr;
      }
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    return this.embedding.embed(texts);
  }
}

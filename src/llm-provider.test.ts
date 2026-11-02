import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createLlmClient, LlmProvider } from "./llm-provider";
import type { FullLlmConfig } from "./llm-provider";

type MockResponse = { ok: boolean; status: number; body: unknown };

function createMockServer(): { url: string; close: () => void; setNextResponse: (r: MockResponse) => void } {
  let nextResponse: MockResponse = { ok: true, status: 200, body: {} };
  const server = Bun.serve({
    port: 0,
    async fetch(_req) {
      const r = nextResponse;
      return new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    close: () => { server.stop(true); },
    setNextResponse: (r: MockResponse) => { nextResponse = r; },
  };
}

describe("LLM Provider Abstraction", () => {
  describe("openai-compatible client", () => {
    let mock: ReturnType<typeof createMockServer>;

    beforeAll(() => {
      mock = createMockServer();
    });

    afterAll(() => {
      mock.close();
    });

    it("generate() returns text and token counts", async () => {
      mock.setNextResponse({
        ok: true,
        status: 200,
        body: {
          choices: [{ message: { content: "Hello world" } }],
          usage: { prompt_tokens: 10, completion_tokens: 3 },
        },
      });
      const client = createLlmClient({
        provider: "openai-compatible",
        baseUrl: mock.url,
        apiKey: "test-key",
        model: "test-model",
      });
      const result = await client.generate("Hi", 0.2);
      expect(result.text).toBe("Hello world");
      expect(result.promptTokens).toBe(10);
      expect(result.completionTokens).toBe(3);
    });

    it("embed() returns embedding vectors", async () => {
      mock.setNextResponse({
        ok: true,
        status: 200,
        body: {
          data: [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0.4, 0.5, 0.6] }],
        },
      });
      const client = createLlmClient({
        provider: "openai-compatible",
        baseUrl: mock.url,
        apiKey: "test-key",
        model: "test-embed",
      });
      const result = await client.embed(["text1", "text2"]);
      expect(result).toEqual([[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]);
    });

    it("embed() returns empty array for empty input", async () => {
      const client = createLlmClient({
        provider: "openai-compatible",
        baseUrl: mock.url,
        apiKey: "test-key",
        model: "test-embed",
      });
      const result = await client.embed([]);
      expect(result).toEqual([]);
    });

    it("generate() throws on non-ok response", async () => {
      mock.setNextResponse({
        ok: false,
        status: 401,
        body: { error: "Unauthorized" },
      });
      const client = createLlmClient({
        provider: "openai-compatible",
        baseUrl: mock.url,
        apiKey: "bad-key",
        model: "test-model",
      });
      await expect(client.generate("Hi")).rejects.toThrow("0penAI-compatible API error");
    });

    it("generate() throws on empty response", async () => {
      mock.setNextResponse({
        ok: true,
        status: 200,
        body: { choices: [{ message: {} }] },
      });
      const client = createLlmClient({
        provider: "openai-compatible",
        baseUrl: mock.url,
        apiKey: "test-key",
        model: "test-model",
      });
      await expect(client.generate("Hi")).rejects.toThrow("LLM response was empty");
    });
  });

  describe("gemini client", () => {
    let mock: ReturnType<typeof createMockServer>;

    beforeAll(() => {
      mock = createMockServer();
    });

    afterAll(() => {
      mock.close();
    });

    it("generate() returns text and token counts", async () => {
      mock.setNextResponse({
        ok: true,
        status: 200,
        body: {
          candidates: [{ content: { parts: [{ text: "Hi there!" }] } }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
        },
      });
      const client = createLlmClient({
        provider: "gemini",
        baseUrl: mock.url,
        apiKey: "test-key",
        model: "gemini-pro",
      });
      const result = await client.generate("Hello", 0.2);
      expect(result.text).toBe("Hi there!");
      expect(result.promptTokens).toBe(5);
      expect(result.completionTokens).toBe(2);
    });

    it("embed() returns embedding vectors", async () => {
      mock.setNextResponse({
        ok: true,
        status: 200,
        body: {
          embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }],
        },
      });
      const client = createLlmClient({
        provider: "gemini",
        baseUrl: mock.url,
        apiKey: "test-key",
        model: "gemini-embedding-001",
      });
      const result = await client.embed(["a", "b"]);
      expect(result).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    });

    it("generate() throws on non-ok response", async () => {
      mock.setNextResponse({
        ok: false,
        status: 403,
        body: { error: "Forbidden" },
      });
      const client = createLlmClient({
        provider: "gemini",
        baseUrl: mock.url,
        apiKey: "bad-key",
        model: "gemini-pro",
      });
      await expect(client.generate("Hi")).rejects.toThrow("Gem1ni API error");
    });
  });

  describe("LlmProvider main→fallback retry", () => {
    let mockMain: ReturnType<typeof createMockServer>;
    let mockFallback: ReturnType<typeof createMockServer>;

    beforeAll(() => {
      mockMain = createMockServer();
      mockFallback = createMockServer();
    });

    afterAll(() => {
      mockMain.close();
      mockFallback.close();
    });

    it("retries on fallback when main fails", async () => {
      mockMain.setNextResponse({
        ok: false,
        status: 500,
        body: { error: "Internal error" },
      });
      mockFallback.setNextResponse({
        ok: true,
        status: 200,
        body: {
          choices: [{ message: { content: "Fallback response" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
      });

      const config: FullLlmConfig = {
        main: { provider: "openai-compatible", baseUrl: mockMain.url, apiKey: "k1", model: "m1" },
        fallback: { provider: "openai-compatible", baseUrl: mockFallback.url, apiKey: "k2", model: "m2" },
        embedding: { provider: "openai-compatible", baseUrl: mockMain.url, apiKey: "k1", model: "m1" },
      };
      const provider = new LlmProvider(config);
      const result = await provider.generate("test");
      expect(result.text).toBe("Fallback response");
    });

    it("uses main directly when fallback is absent", async () => {
      mockMain.setNextResponse({
        ok: true,
        status: 200,
        body: {
          choices: [{ message: { content: "Main response" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
      });
      const config: FullLlmConfig = {
        main: { provider: "openai-compatible", baseUrl: mockMain.url, apiKey: "k1", model: "m1" },
        embedding: { provider: "openai-compatible", baseUrl: mockMain.url, apiKey: "k1", model: "m1" },
      };
      const provider = new LlmProvider(config);
      const result = await provider.generate("test");
      expect(result.text).toBe("Main response");
    });
  });
});

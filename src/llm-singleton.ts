import { LlmProvider } from "./llm-provider";
import { resolveLlmConfig } from "./llm-config-service";

let currentProvider: LlmProvider | null = null;
let providerResolvedAt = 0;
let refreshInFlight: Promise<LlmProvider> | null = null;

export async function getLlmProvider(): Promise<LlmProvider> {
  const now = Date.now();
  if (currentProvider !== null && now - providerResolvedAt < 30_000) {
    return currentProvider;
  }
  if (refreshInFlight !== null) {
    return refreshInFlight;
  }
  refreshInFlight = (async () => {
    const config = await resolveLlmConfig();
    currentProvider = new LlmProvider(config);
    providerResolvedAt = Date.now();
    return currentProvider;
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

export function setLlmProvider(provider: LlmProvider): void {
  currentProvider = provider;
  providerResolvedAt = Date.now();
}

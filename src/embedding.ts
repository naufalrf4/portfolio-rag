import { getLlmProvider } from "./llm-singleton";
import { RagServiceError } from "./errors";

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const provider = await getLlmProvider();
  return provider.embed(texts);
}

export async function generateText(
  prompt: string,
  model: string,
  temperature: number = 0.2,
): Promise<{ text: string; promptTokens: number; completionTokens: number }> {
  const provider = await getLlmProvider();
  return provider.generate(prompt, temperature);
}

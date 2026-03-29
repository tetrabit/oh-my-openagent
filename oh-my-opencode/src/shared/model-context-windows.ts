/** Known context window sizes (in tokens) for runtime fallback decisions */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic
  "anthropic/claude-sonnet-4-20250514": 200_000,
  "anthropic/claude-opus-4-20250514": 200_000,
  "anthropic/claude-haiku-3.5": 200_000,
  
  // OpenAI  
  "openai/gpt-5.2": 1_000_000,
  "openai/gpt-5.2-codex": 1_000_000,
  "openai/gpt-5-nano": 128_000,
  
  // Google
  "google/gemini-3-pro": 2_000_000,
  "google/gemini-3-flash": 1_000_000,
  
  // Others
  "xai/grok-code": 131_072,
  "zhipu/glm-4.7": 128_000,
}

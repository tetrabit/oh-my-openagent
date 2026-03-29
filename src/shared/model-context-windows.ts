const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "anthropic/claude-opus-4-5": 200_000,
  "anthropic/claude-sonnet-4-5": 200_000,
  "anthropic/claude-haiku-4-5": 200_000,

  "openai/gpt-5.2": 1_000_000,
  "openai/gpt-5.2-codex": 1_000_000,
  "openai/gpt-5-nano": 128_000,

  "google/gemini-3-pro": 2_000_000,
  "google/gemini-3-flash": 1_000_000,

  "zai-coding-plan/glm-4.7": 128_000,
  "zai-coding-plan/glm-4.6v": 128_000,

  "github-copilot/gpt-5.2": 1_000_000,
  "github-copilot/gpt-5.2-codex": 1_000_000,
  "github-copilot/claude-opus-4-5": 200_000,
  "github-copilot/claude-sonnet-4-5": 200_000,
  "github-copilot/claude-haiku-4-5": 200_000,
  "github-copilot/gemini-3-pro": 2_000_000,
  "github-copilot/gemini-3-flash": 1_000_000,

  "opencode/gpt-5-nano": 128_000,
  "opencode/big-pickle": 200_000,
}

function normalizeModelName(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/claude-(opus|sonnet|haiku)-4\.5/g, "claude-$1-4-5")
}

export function getModelContextWindow(model?: string): number | undefined {
  if (!model) return undefined

  const normalized = normalizeModelName(model)
  const exact = MODEL_CONTEXT_WINDOWS[normalized]
  if (exact !== undefined) return exact

  if (!normalized.includes("/")) {
    for (const [key, limit] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
      if (key.endsWith(`/${normalized}`)) return limit
    }
  }

  for (const [key, limit] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (normalized.includes(key) || key.includes(normalized)) return limit
  }

  return undefined
}

export { MODEL_CONTEXT_WINDOWS }

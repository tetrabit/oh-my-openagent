export const OPENCODE_PROMPT_QUEUE_METADATA_KEY = "opencodePromptQueue"

export type PromptQueueSupersedePending = "all" | "matching-key"

export interface PromptQueueControl {
  supersessionKey?: string
  attemptID: string
  supersedePending?: PromptQueueSupersedePending
}

type PromptPart = {
  type?: string
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

type PromptArgsWithParts = {
  body?: {
    parts?: PromptPart[]
    [key: string]: unknown
  }
  [key: string]: unknown
}

export function createPromptAttemptID(): string {
  return crypto.randomUUID()
}

export function createSessionPromptSupersessionKey(sessionID: string, scope: string): string {
  return `${scope}:${sessionID}`
}

export function withPromptQueueControl<T extends PromptArgsWithParts>(
  promptArgs: T,
  control: PromptQueueControl,
): T {
  const parts = promptArgs.body?.parts
  if (!Array.isArray(parts) || parts.length === 0) {
    return promptArgs
  }

  const targetIndex = parts.findIndex(
    (part) => part && typeof part === "object" && part.type === "text",
  )
  const index = targetIndex >= 0 ? targetIndex : 0
  const targetPart = parts[index]

  if (!targetPart || typeof targetPart !== "object") {
    return promptArgs
  }

  const nextParts = parts.slice()
  nextParts[index] = {
    ...targetPart,
    metadata: {
      ...(typeof targetPart.metadata === "object" && targetPart.metadata !== null ? targetPart.metadata : {}),
      [OPENCODE_PROMPT_QUEUE_METADATA_KEY]: {
        supersessionKey: control.supersessionKey,
        attemptID: control.attemptID,
        ...(control.supersedePending ? { supersedePending: control.supersedePending } : {}),
      },
    },
  }

  return {
    ...promptArgs,
    body: {
      ...(promptArgs.body ?? {}),
      parts: nextParts,
    },
  }
}

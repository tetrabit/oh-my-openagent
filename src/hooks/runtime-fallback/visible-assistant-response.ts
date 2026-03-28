import type { HookDeps } from "./types"
import type { SessionMessage, SessionMessagePart } from "./session-messages"
import { extractSessionMessages } from "./session-messages"
import { extractAutoRetrySignal } from "./error-classifier"

export interface AssistantResponseActivity {
  hasProgress: boolean
  hasVisibleResponse: boolean
}

function getLastUserMessageIndex(messages: SessionMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.info?.role === "user") {
      return index
    }
  }

  return -1
}

function inspectAssistantParts(
  parts: SessionMessagePart[] | undefined,
  extractAutoRetrySignalFn: typeof extractAutoRetrySignal,
): AssistantResponseActivity {
  if (!parts || parts.length === 0) {
    return {
      hasProgress: false,
      hasVisibleResponse: false,
    }
  }

  let hasProgress = false
  let hasVisibleResponse = false

  for (const part of parts) {
    const text = typeof part.text === "string" ? part.text.trim() : ""

    if (part.type === "tool" || part.type === "step-start" || part.type === "step-finish") {
      hasProgress = true
      continue
    }

    if (part.type === "reasoning" && text.length > 0) {
      hasProgress = true
      continue
    }

    if (part.type !== "text" || text.length === 0) {
      continue
    }

    if (extractAutoRetrySignalFn({ message: text })) {
      continue
    }

    hasProgress = true
    hasVisibleResponse = true
  }

  return {
    hasProgress,
    hasVisibleResponse,
  }
}

export function inspectAssistantResponseActivity(extractAutoRetrySignalFn: typeof extractAutoRetrySignal) {
  return async (
    ctx: HookDeps["ctx"],
    sessionID: string,
    fallbackParts?: SessionMessagePart[],
  ): Promise<AssistantResponseActivity> => {
    try {
      const messagesResponse = await ctx.client.session.messages({
        path: { id: sessionID },
        query: { directory: ctx.directory },
      })
      const messages = extractSessionMessages(messagesResponse)
      if (!messages || messages.length === 0) {
        return inspectAssistantParts(fallbackParts, extractAutoRetrySignalFn)
      }

      const lastUserMessageIndex = getLastUserMessageIndex(messages)
      if (lastUserMessageIndex === -1) {
        return inspectAssistantParts(fallbackParts, extractAutoRetrySignalFn)
      }

      for (let index = messages.length - 1; index > lastUserMessageIndex; index--) {
        const message = messages[index]
        if (message?.info?.role !== "assistant") {
          continue
        }

        if (message.info?.error) {
          return {
            hasProgress: false,
            hasVisibleResponse: false,
          }
        }

        const infoParts = message.info?.parts
        const infoMessageParts = Array.isArray(infoParts)
          ? infoParts.filter((part): part is SessionMessagePart => typeof part === "object" && part !== null)
          : undefined
        const parts = message.parts && message.parts.length > 0
          ? message.parts
          : infoMessageParts

        return inspectAssistantParts(parts, extractAutoRetrySignalFn)
      }

      return inspectAssistantParts(fallbackParts, extractAutoRetrySignalFn)
    } catch {
      return inspectAssistantParts(fallbackParts, extractAutoRetrySignalFn)
    }
  }
}

export function hasVisibleAssistantResponse(extractAutoRetrySignalFn: typeof extractAutoRetrySignal) {
  const inspectAssistantActivity = inspectAssistantResponseActivity(extractAutoRetrySignalFn)

  return async (
    ctx: HookDeps["ctx"],
    sessionID: string,
    _info: Record<string, unknown> | undefined,
  ): Promise<boolean> => {
    const activity = await inspectAssistantActivity(ctx, sessionID)
    return activity.hasVisibleResponse
  }
}

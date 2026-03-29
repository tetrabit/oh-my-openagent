import type { HookDeps } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { HOOK_NAME, RETRYABLE_ERROR_PATTERNS } from "./constants"
import { log } from "../../shared/logger"
import { extractAutoRetrySignal } from "./error-classifier"
import { normalizeRetryStatusMessage, extractRetryAttempt } from "../../shared/retry-status-utils"

export function createSessionStatusHandler(
  deps: HookDeps,
  helpers: AutoRetryHelpers,
  sessionStatusRetryKeys: Map<string, string>,
) {
  const {
    sessionStates,
    sessionLastAccess,
    sessionAwaitingFallbackResult,
  } = deps

  return async (props: Record<string, unknown> | undefined) => {
    const sessionID = props?.sessionID as string | undefined
    const status = props?.status as { type?: string; message?: string; attempt?: number } | undefined
    const model = props?.model as string | undefined

    if (!sessionID || status?.type !== "retry") return

    const retryMessage = typeof status.message === "string" ? status.message : ""
    const retrySignal = extractAutoRetrySignal({ status: retryMessage, message: retryMessage })
    if (!retrySignal) {
      // Fallback: status.type is already "retry", so check the message against
      // retryable error patterns directly. This handles providers like Gemini whose
      // retry status message may not contain "retrying in" text alongside the error.
      const messageLower = retryMessage.toLowerCase()
      const matchesRetryablePattern = RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(messageLower))
      if (!matchesRetryablePattern) return
    }

    const retryKey = `${extractRetryAttempt(status.attempt, retryMessage)}:${normalizeRetryStatusMessage(retryMessage)}`
    if (sessionStatusRetryKeys.get(sessionID) === retryKey) {
      return
    }
    sessionStatusRetryKeys.set(sessionID, retryKey)

    const awaitingFallbackResult = sessionAwaitingFallbackResult.has(sessionID)
    if (awaitingFallbackResult) {
      helpers.clearSessionFallbackTimeout(sessionID)
    }

    sessionLastAccess.set(sessionID, Date.now())
    const state = sessionStates.get(sessionID)

    log(`[${HOOK_NAME}] Observed provider-managed retry in session.status; keeping current model`, {
      sessionID,
      model: state?.currentModel ?? model,
      retryAttempt: status.attempt,
      awaitingFallbackResult,
    })
  }
}

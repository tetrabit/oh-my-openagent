import type { HookDeps } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { HOOK_NAME } from "./constants"
import { log } from "../../shared/logger"
import { extractStatusCode, extractErrorName, classifyErrorType, isAbortLikeError, isRetryableError, extractAutoRetrySignal, containsErrorContent } from "./error-classifier"
import { createFallbackState, prepareFallback } from "./fallback-state"
import { getFallbackModelsForSession } from "./fallback-models"

type AssistantPart = { type?: string; text?: string }

type AssistantActivity = {
  hasProgress: boolean
  hasVisibleResponse: boolean
}

function inspectAssistantParts(
  parts: AssistantPart[] | undefined,
  extractAutoRetrySignalFn: typeof extractAutoRetrySignal,
): AssistantActivity {
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

    if (part.type === "text" && text.length > 0) {
      const isRetrySignal = Boolean(extractAutoRetrySignalFn({ message: text }))
      const hasErrorContent = containsErrorContent([{ type: "text", text }]).hasError

      if (!isRetrySignal && !hasErrorContent) {
        hasProgress = true
        hasVisibleResponse = true
      }
    }
  }

  return {
    hasProgress,
    hasVisibleResponse,
  }
}

export function inspectAssistantActivity(extractAutoRetrySignalFn: typeof extractAutoRetrySignal) {
  return async (
    ctx: HookDeps["ctx"],
    sessionID: string,
    info: Record<string, unknown> | undefined,
    fallbackParts?: AssistantPart[],
  ): Promise<AssistantActivity> => {
    try {
      const messagesResp = await ctx.client.session.messages({
        path: { id: sessionID },
        query: { directory: ctx.directory },
      })

      const msgs = (messagesResp as {
        data?: Array<{
          info?: Record<string, unknown>
          parts?: Array<{ type?: string; text?: string }>
        }>
      }).data

      if (!msgs || msgs.length === 0) {
        return inspectAssistantParts(fallbackParts, extractAutoRetrySignalFn)
      }

      let lastUserIndex = -1
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i]?.info?.role === "user") {
          lastUserIndex = i
          break
        }
      }

      let lastAssistant: {
        info?: Record<string, unknown>
        parts?: AssistantPart[]
      } | undefined

      for (let i = msgs.length - 1; i > lastUserIndex; i--) {
        if (msgs[i]?.info?.role === "assistant") {
          lastAssistant = msgs[i]
          break
        }
      }

      if (!lastAssistant) {
        return inspectAssistantParts(fallbackParts, extractAutoRetrySignalFn)
      }
      if (lastAssistant.info?.error) {
        return {
          hasProgress: false,
          hasVisibleResponse: false,
        }
      }

      const parts = lastAssistant.parts ??
        (lastAssistant.info?.parts as AssistantPart[] | undefined)

      return inspectAssistantParts(parts, extractAutoRetrySignalFn)
    } catch {
      return inspectAssistantParts(fallbackParts, extractAutoRetrySignalFn)
    }
  }
}

export function createMessageUpdateHandler(deps: HookDeps, helpers: AutoRetryHelpers) {
  const {
    ctx,
    config,
    pluginConfig,
    sessionStates,
    sessionLastAccess,
    sessionRetryInFlight,
    sessionAwaitingFallbackResult,
    sessionTokenRefreshRetryCounts,
  } = deps
  const checkAssistantActivity = inspectAssistantActivity(extractAutoRetrySignal)

  return async (props: Record<string, unknown> | undefined) => {
    const info = props?.info as Record<string, unknown> | undefined
    const sessionID = info?.sessionID as string | undefined
    const retrySignalResult = extractAutoRetrySignal(info)
    const retrySignal = retrySignalResult?.signal
    const parts = props?.parts as Array<{ type?: string; text?: string }> | undefined
    const errorContentResult = containsErrorContent(parts)
    const error = info?.error ??
      (errorContentResult.hasError ? { name: "MessageContentError", message: errorContentResult.errorMessage || "Message contains error content" } : undefined)
    const role = info?.role as string | undefined
    const model = info?.model as string | undefined

    if (sessionID && role === "assistant" && !error) {
      if (!sessionAwaitingFallbackResult.has(sessionID)) {
        return
      }

      if (retrySignal) {
        helpers.clearSessionFallbackTimeout(sessionID)
        log(`[${HOOK_NAME}] Provider-managed retry observed; suspended fallback timeout`, {
          sessionID,
          model,
        })
        return
      }

      const activity = await checkAssistantActivity(ctx, sessionID, info, parts)
      if (!activity.hasProgress) {
        log(`[${HOOK_NAME}] Assistant update observed without visible final response; keeping fallback timeout`, {
          sessionID,
          model,
        })
        return
      }

      sessionAwaitingFallbackResult.delete(sessionID)
      sessionTokenRefreshRetryCounts.delete(sessionID)
      helpers.clearSessionFallbackTimeout(sessionID)
      const state = sessionStates.get(sessionID)
      if (state?.pendingFallbackModel) {
        state.pendingFallbackModel = undefined
      }
      if (state && state.currentModel !== state.originalModel) {
        state.mirrorFallbackOnNextUserTurn = true
      }
      log(`[${HOOK_NAME}] Assistant progress observed; cleared fallback timeout`, {
        sessionID,
        model,
        hasVisibleResponse: activity.hasVisibleResponse,
      })
      return
    }

    if (sessionID && role === "assistant" && error) {
      const wasAwaitingFallbackResult = sessionAwaitingFallbackResult.has(sessionID)
      if (retrySignal) {
        helpers.clearSessionFallbackTimeout(sessionID)
        log(`[${HOOK_NAME}] Provider-managed retry observed in message.updated; not triggering fallback`, {
          sessionID,
          model,
        })
        return
      }

      if (wasAwaitingFallbackResult && isAbortLikeError(error)) {
        log(`[${HOOK_NAME}] Ignoring assistant abort while awaiting fallback result`, { sessionID, model })
        return
      }

      sessionAwaitingFallbackResult.delete(sessionID)
      if (sessionRetryInFlight.has(sessionID) && !retrySignal) {
        if (wasAwaitingFallbackResult) {
          log(`[${HOOK_NAME}] Processing assistant error while awaiting fallback result`, { sessionID })
          sessionRetryInFlight.delete(sessionID)
        } else {
          log(`[${HOOK_NAME}] message.updated fallback skipped (retry in flight)`, { sessionID })
          return
        }
      }

      helpers.clearSessionFallbackTimeout(sessionID)
      const statusCode = extractStatusCode(error, config.retry_on_errors)
      const errorName = extractErrorName(error)
      const errorType = classifyErrorType(error)

      log(`[${HOOK_NAME}] message.updated with assistant error`, {
        sessionID,
        model,
        statusCode,
        errorName,
        errorType,
      })

      let state = sessionStates.get(sessionID)
      const agent = info?.agent as string | undefined
      const resolvedAgent = await helpers.resolveAgentForSessionFromContext(sessionID, agent)

      if (!state) {
        let initialModel = model
        if (!initialModel) {
          const detectedAgent = resolvedAgent
          const agentConfig = detectedAgent
            ? pluginConfig?.agents?.[detectedAgent as keyof typeof pluginConfig.agents]
            : undefined
          const agentModel = agentConfig?.model as string | undefined
          if (agentModel) {
            log(`[${HOOK_NAME}] Derived model from agent config for message.updated`, {
              sessionID,
              agent: detectedAgent,
              model: agentModel,
            })
            initialModel = agentModel
          }
        }

        if (!initialModel) {
          log(`[${HOOK_NAME}] message.updated missing model info, cannot fallback`, {
            sessionID,
            errorName: extractErrorName(error),
            errorType: classifyErrorType(error),
          })
          return
        }

        state = createFallbackState(initialModel)
        sessionStates.set(sessionID, state)
        sessionLastAccess.set(sessionID, Date.now())
      } else {
        sessionLastAccess.set(sessionID, Date.now())
      }

      if (errorType === "token_refresh_failed" && state?.currentModel) {
        const recoveryResult = await helpers.retryCurrentModelAfterTokenRefreshFailure(
          sessionID,
          state.currentModel,
          resolvedAgent,
          "message.updated",
        )
        if (recoveryResult === "retry-dispatched") {
          return
        }
      } else {
        helpers.clearTokenRefreshRetryState(sessionID)
      }

      if (!isRetryableError(error, config.retry_on_errors)) {
        log(`[${HOOK_NAME}] message.updated error not retryable, skipping fallback`, {
          sessionID,
          statusCode,
          errorName,
          errorType,
        })
        return
      }

      const fallbackModels = getFallbackModelsForSession(sessionID, resolvedAgent, pluginConfig)

      if (fallbackModels.length === 0) {
        return
      }

      if (state.pendingFallbackModel) {
        if (wasAwaitingFallbackResult) {
          log(`[${HOOK_NAME}] Clearing pending fallback after assistant error while awaiting fallback result`, {
            sessionID,
            pendingFallbackModel: state.pendingFallbackModel,
          })
          state.pendingFallbackModel = undefined
        } else {
          log(`[${HOOK_NAME}] message.updated fallback skipped (pending fallback in progress)`, {
            sessionID,
            pendingFallbackModel: state.pendingFallbackModel,
          })
          return
        }
      }

      const result = prepareFallback(sessionID, state, fallbackModels, config)

      if (result.success && config.notify_on_fallback) {
        await deps.ctx.client.tui
          .showToast({
            body: {
              title: "Model Fallback",
              message: `Switching to ${result.newModel?.split("/").pop() || result.newModel} for next request`,
              variant: "warning",
              duration: 5000,
            },
          })
          .catch(() => {})
      }

      if (result.success && result.newModel) {
        await helpers.autoRetryWithFallback(sessionID, result.newModel, resolvedAgent, "message.updated")
      }
    }
  }
}

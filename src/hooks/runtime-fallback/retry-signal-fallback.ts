import type { HookDeps } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { HOOK_NAME } from "./constants"
import { log } from "../../shared/logger"
import { createFallbackState } from "./fallback-state"
import { getFallbackModelsForSession } from "./fallback-models"
import { resolveFallbackBootstrapModel } from "./fallback-bootstrap-model"
import { dispatchFallbackRetry } from "./fallback-retry-dispatcher"

type RetrySignalFallbackOptions = {
  sessionID: string
  model: string | undefined
  agent: string | undefined
  source: string
}

/**
 * Handles provider retry signals by immediately triggering model fallback.
 * Returns true if fallback was dispatched, false if no fallback models available.
 */
export async function dispatchFallbackOnRetrySignal(
  deps: HookDeps,
  helpers: AutoRetryHelpers,
  options: RetrySignalFallbackOptions,
): Promise<boolean> {
  const { sessionID, model, agent, source } = options
  const resolvedAgent = await helpers.resolveAgentForSessionFromContext(sessionID, agent)

  let state = deps.sessionStates.get(sessionID)
  if (!state) {
    const initialModel = resolveFallbackBootstrapModel({
      sessionID,
      source,
      eventModel: model,
      resolvedAgent,
      pluginConfig: deps.pluginConfig,
    })
    if (initialModel) {
      state = createFallbackState(initialModel)
      deps.sessionStates.set(sessionID, state)
      deps.sessionLastAccess.set(sessionID, Date.now())
    }
  }

  const fallbackModels = state
    ? getFallbackModelsForSession(sessionID, resolvedAgent, deps.pluginConfig)
    : []

  if (state && fallbackModels.length > 0) {
    log(`[${HOOK_NAME}] Provider retry detected; triggering immediate fallback`, {
      sessionID,
      model,
      source,
    })
    await dispatchFallbackRetry(deps, helpers, {
      sessionID,
      state,
      fallbackModels,
      resolvedAgent,
      source,
    })
    return true
  }

  log(`[${HOOK_NAME}] Provider retry detected but no fallback models available`, {
    sessionID,
    model,
    source,
  })
  return false
}
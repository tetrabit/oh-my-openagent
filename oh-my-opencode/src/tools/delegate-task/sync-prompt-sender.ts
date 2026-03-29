import type { DelegateTaskArgs, OpencodeClient } from "./types"
import { isPlanFamily } from "./constants"
import {
  promptSyncWithModelSuggestionRetry,
  promptWithModelSuggestionRetry,
} from "../../shared/model-suggestion-retry"
import { sendPromptWithFallbackRetry } from "../../shared/prompt-fallback-retry"
import { formatDetailedError } from "./error-formatting"
import { getAgentToolRestrictions } from "../../shared/agent-tool-restrictions"
import { setSessionTools } from "../../shared/session-tools-store"
import { createInternalAgentTextPart } from "../../shared/internal-initiator-marker"
import { setSessionModel } from "../../shared/session-model-state"
import type { FallbackEntry } from "../../shared/model-requirements"

type SendSyncPromptDeps = {
  promptWithModelSuggestionRetry: typeof promptWithModelSuggestionRetry
  promptSyncWithModelSuggestionRetry: typeof promptSyncWithModelSuggestionRetry
}

const sendSyncPromptDeps: SendSyncPromptDeps = {
  promptWithModelSuggestionRetry,
  promptSyncWithModelSuggestionRetry,
}

function isOracleAgent(agentToUse: string): boolean {
  return agentToUse.toLowerCase() === "oracle"
}

function isUnexpectedEofError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const lowered = message.toLowerCase()
  return lowered.includes("unexpected eof") || lowered.includes("json parse error")
}

export async function sendSyncPrompt(
  client: OpencodeClient,
  input: {
    sessionID: string
    agentToUse: string
    args: DelegateTaskArgs
    systemContent: string | undefined
    categoryModel: { providerID: string; modelID: string; variant?: string } | undefined
    fallbackChain?: FallbackEntry[]
    toastManager: { removeTask: (id: string) => void } | null | undefined
    taskId: string | undefined
  },
  deps: SendSyncPromptDeps = sendSyncPromptDeps
): Promise<string | null> {
  const allowTask = isPlanFamily(input.agentToUse)
  const tools = {
    task: allowTask,
    call_omo_agent: true,
    question: false,
    ...getAgentToolRestrictions(input.agentToUse),
  }
  setSessionTools(input.sessionID, tools)

  const promptArgs = {
    path: { id: input.sessionID },
    body: {
      agent: input.agentToUse,
      system: input.systemContent,
      tools,
      parts: [createInternalAgentTextPart(input.args.prompt)],
      ...(input.categoryModel
        ? { model: { providerID: input.categoryModel.providerID, modelID: input.categoryModel.modelID } }
        : {}),
      ...(input.categoryModel?.variant ? { variant: input.categoryModel.variant } : {}),
    },
  }

  try {
    const promptResult = await sendPromptWithFallbackRetry({
      promptArgs,
      currentModel: input.categoryModel,
      fallbackChain: input.fallbackChain,
      sendPrompt: (nextPromptArgs) => deps.promptWithModelSuggestionRetry(client, nextPromptArgs),
    })
    if (promptResult.usedFallback && promptResult.providerID && promptResult.modelID) {
      setSessionModel(input.sessionID, {
        providerID: promptResult.providerID,
        modelID: promptResult.modelID,
      })
    }
  } catch (promptError) {
    if (isOracleAgent(input.agentToUse) && isUnexpectedEofError(promptError)) {
      try {
        await deps.promptSyncWithModelSuggestionRetry(client, promptArgs)
        return null
      } catch (oracleRetryError) {
        promptError = oracleRetryError
      }
    }

    if (input.toastManager && input.taskId !== undefined) {
      input.toastManager.removeTask(input.taskId)
    }
    const errorMessage = promptError instanceof Error ? promptError.message : String(promptError)
    if (errorMessage.includes("agent.name") || errorMessage.includes("undefined")) {
      return formatDetailedError(new Error(`Agent "${input.agentToUse}" not found. Make sure the agent is registered in your opencode.json or provided by a plugin.`), {
        operation: "Send prompt to agent",
        args: input.args,
        sessionID: input.sessionID,
        agent: input.agentToUse,
        category: input.args.category,
      })
    }
    return formatDetailedError(promptError, {
      operation: "Send prompt",
      args: input.args,
      sessionID: input.sessionID,
      agent: input.agentToUse,
      category: input.args.category,
    })
  }

  return null
}

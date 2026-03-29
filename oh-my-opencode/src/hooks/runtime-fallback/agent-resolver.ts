import { getSessionAgent } from "../../features/claude-code-session-state"

export const AGENT_NAMES = [
  "sisyphus",
  "oracle",
  "librarian",
  "explore",
  "prometheus",
  "atlas",
  "metis",
  "momus",
  "hephaestus",
  "sisyphus-junior",
  "build",
  "plan",
  "multimodal-looker",
]

export const agentPattern = new RegExp(
  `\\b(${AGENT_NAMES
    .sort((a, b) => b.length - a.length)
    .map((a) => a.replace(/-/g, "\\-"))
    .join("|")})\\b`,
  "i",
)

export function detectAgentFromSession(sessionID: string): string | undefined {
  const match = sessionID.match(agentPattern)
  if (match) {
    return match[1].toLowerCase()
  }
  return undefined
}

export function normalizeAgentName(agent: string | undefined): string | undefined {
  if (!agent) return undefined
  return normalizeAgentNameWithKnown(agent, [])
}

export function normalizeAgentNameWithKnown(
  agent: string | undefined,
  knownAgents: readonly string[] = [],
): string | undefined {
  if (!agent) return undefined
  const normalized = agent.toLowerCase().trim()
  if (knownAgents.some((name) => name.toLowerCase() === normalized)) {
    return normalized
  }
  if (AGENT_NAMES.includes(normalized)) {
    return normalized
  }
  const match = normalized.match(agentPattern)
  if (match) {
    return match[1].toLowerCase()
  }
  return undefined
}

export function resolveAgentForSession(sessionID: string, eventAgent?: string): string | undefined {
  return resolveAgentForSessionWithKnown(sessionID, eventAgent, [])
}

export function resolveAgentForSessionWithKnown(
  sessionID: string,
  eventAgent: string | undefined,
  knownAgents: readonly string[] = [],
): string | undefined {
  return (
    normalizeAgentNameWithKnown(eventAgent, knownAgents) ??
    normalizeAgentNameWithKnown(getSessionAgent(sessionID), knownAgents) ??
    detectAgentFromSession(sessionID)
  )
}

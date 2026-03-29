import { HOOK_NAME } from "./constants"
import { log } from "../../shared/logger"
import { parseModelString } from "../../tools/delegate-task/model-string-parser"

const ANTHROPIC_STATUS_SUMMARY_URL = "https://status.claude.com/api/v2/summary.json"
const ANTHROPIC_STATUS_CACHE_TTL_MS = 10_000
const RELEVANT_COMPONENT_PATTERNS = [/^Claude API\b/i, /^Claude Code$/i]

type CachedAnthropicStatus = {
  fetchedAt: number
  snapshot: AnthropicStatusSnapshot | undefined
}

export interface AnthropicStatusSnapshot {
  checkedAt: number
  degraded: boolean
  indicator?: string
  description?: string
  incidentName?: string
  incidentStatus?: string
  impactedComponents: string[]
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function isRelevantComponent(name: string | undefined): boolean {
  if (!name) return false
  return RELEVANT_COMPONENT_PATTERNS.some((pattern) => pattern.test(name))
}

function collectImpactedComponents(values: unknown[]): string[] {
  const impacted = new Set<string>()

  for (const value of values) {
    const entry = asRecord(value)
    const name = asString(entry?.name)
    const status = asString(entry?.status)
    if (!isRelevantComponent(name)) {
      continue
    }

    if (name && status && status !== "operational") {
      impacted.add(name)
    }
  }

  return [...impacted]
}

function parseAnthropicStatusSnapshot(payload: unknown): AnthropicStatusSnapshot {
  const now = Date.now()
  const root = asRecord(payload)
  const status = asRecord(root?.status)
  const indicator = asString(status?.indicator)
  const description = asString(status?.description)
  const components = Array.isArray(root?.components) ? root.components : []
  const incidents = Array.isArray(root?.incidents) ? root.incidents : []
  const impactedComponents = new Set<string>(collectImpactedComponents(components))

  let incidentName: string | undefined
  let incidentStatus: string | undefined

  for (const value of incidents) {
    const incident = asRecord(value)
    const currentStatus = asString(incident?.status)
    if (currentStatus === "resolved" || currentStatus === "completed") {
      continue
    }

    const incidentComponents = Array.isArray(incident?.components) ? incident.components : []
    const affectedComponentNames = collectImpactedComponents(incidentComponents)
    for (const name of affectedComponentNames) {
      impactedComponents.add(name)
    }

    if (!incidentName && affectedComponentNames.length > 0) {
      incidentName = asString(incident?.name)
      incidentStatus = currentStatus
    }
  }

  return {
    checkedAt: now,
    degraded: impactedComponents.size > 0,
    indicator,
    description,
    incidentName,
    incidentStatus,
    impactedComponents: [...impactedComponents],
  }
}

export function isDirectAnthropicModel(model: string): boolean {
  return parseModelString(model)?.providerID === "anthropic"
}

export async function getAnthropicStatusSnapshot(
  cacheRef: { current?: CachedAnthropicStatus },
): Promise<AnthropicStatusSnapshot | undefined> {
  const cached = cacheRef.current
  if (cached && (Date.now() - cached.fetchedAt) < ANTHROPIC_STATUS_CACHE_TTL_MS) {
    return cached.snapshot
  }

  try {
    const response = await fetch(ANTHROPIC_STATUS_SUMMARY_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    })

    if (!response.ok) {
      log(`[${HOOK_NAME}] Anthropic status fetch failed`, { statusCode: response.status })
      cacheRef.current = { fetchedAt: Date.now(), snapshot: undefined }
      return undefined
    }

    const snapshot = parseAnthropicStatusSnapshot(await response.json())
    cacheRef.current = { fetchedAt: Date.now(), snapshot }
    return snapshot
  } catch (error) {
    log(`[${HOOK_NAME}] Anthropic status fetch errored`, {
      error: error instanceof Error ? error.message : String(error),
    })
    cacheRef.current = { fetchedAt: Date.now(), snapshot: undefined }
    return undefined
  }
}

import { OMO_INTERNAL_INITIATOR_MARKER } from "../../shared"

export interface FallbackResumeMessage {
  info?: Record<string, unknown>
  parts?: Array<{ type?: string; text?: string }>
}

const MAX_USER_PROMPT_CHARS = 4000
const MAX_ASSISTANT_OUTPUT_CHARS = 6000

function extractMessageText(parts: FallbackResumeMessage["parts"]): string {
  if (!Array.isArray(parts)) return ""

  return parts
    .flatMap((part) => {
      if (part?.type !== "text" || typeof part.text !== "string") {
        return []
      }

      return [part.text.replaceAll(OMO_INTERNAL_INITIATOR_MARKER, "").trim()]
    })
    .filter((text) => text.length > 0)
    .join("\n\n")
    .trim()
}

function isInternalUserMessage(message: FallbackResumeMessage | undefined): boolean {
  if (message?.info?.role !== "user" || !Array.isArray(message.parts)) {
    return false
  }

  return message.parts.some(
    (part) => part?.type === "text" && typeof part.text === "string" && part.text.includes(OMO_INTERNAL_INITIATOR_MARKER),
  )
}

function truncateStart(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars).trimEnd()}\n...[truncated]`
}

function truncateEnd(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `[truncated earlier content]\n${text.slice(-maxChars).trimStart()}`
}

export function findFallbackResumeAnchor(
  messages: FallbackResumeMessage[],
): { message: FallbackResumeMessage; index: number } | undefined {
  let fallbackUser: { message: FallbackResumeMessage; index: number } | undefined

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.info?.role !== "user") continue

    fallbackUser ??= { message, index: i }
    if (!isInternalUserMessage(message)) {
      return { message, index: i }
    }
  }

  return fallbackUser
}

function collectAssistantOutput(messages: FallbackResumeMessage[], startIndex: number): string {
  const chunks: string[] = []

  for (let i = startIndex + 1; i < messages.length; i++) {
    if (messages[i]?.info?.role !== "assistant") continue

    const text = extractMessageText(messages[i]?.parts)
    if (!text) continue
    if (chunks[chunks.length - 1] === text) continue
    chunks.push(text)
  }

  return chunks.join("\n\n").trim()
}

export function createFallbackResumePrompt(
  source: string,
  newModel: string,
  messages?: FallbackResumeMessage[],
): string {
  const lines = [
    `Internal runtime fallback handoff (${source}, ${newModel}).`,
    "Resume the interrupted task in this existing session using the conversation context already present.",
    "Use the last real user prompt and any assistant output below as continuation anchors.",
    "Do not ask the user to restate the task.",
    "Do not restart from the beginning.",
    "Continue from the point of interruption.",
  ]

  if (!messages || messages.length === 0) {
    return lines.join("\n")
  }

  const anchor = findFallbackResumeAnchor(messages)
  const lastUserPrompt = truncateStart(extractMessageText(anchor?.message.parts), MAX_USER_PROMPT_CHARS)
  const assistantOutput = anchor
    ? truncateEnd(collectAssistantOutput(messages, anchor.index), MAX_ASSISTANT_OUTPUT_CHARS)
    : ""

  if (lastUserPrompt) {
    lines.push("", "Last user prompt:", lastUserPrompt)
  }

  if (assistantOutput) {
    lines.push("", "Assistant output before interruption:", assistantOutput)
  }

  return lines.join("\n")
}

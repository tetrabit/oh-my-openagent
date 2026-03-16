import { beforeEach, describe, expect, it, spyOn } from "bun:test"
import type { LoadedSkill } from "../../features/opencode-skill-loader/types"
import { AUTO_SLASH_COMMAND_TAG_OPEN } from "./constants"
import { createAutoSlashCommandHook } from "./hook"
import { createProcessedCommandStore } from "./processed-command-store"
import type {
  AutoSlashCommandHookInput,
  AutoSlashCommandHookOutput,
  CommandExecuteBeforeInput,
  CommandExecuteBeforeOutput,
} from "./types"

function createSkill(name: string): LoadedSkill {
  return {
    name,
    path: `/test/skills/${name}/SKILL.md`,
    definition: {
      name,
      description: `Test skill: ${name}`,
      template: `Instructions for ${name}`,
    },
    scope: "user",
  }
}

function createHookWithSkills(skillNames: string[]) {
  return createAutoSlashCommandHook({
    skills: skillNames.map(createSkill),
  })
}

function createChatInput(sessionID: string, messageID: string): AutoSlashCommandHookInput {
  return {
    sessionID,
    messageID,
  }
}

function createChatOutput(text: string): AutoSlashCommandHookOutput {
  return {
    message: {},
    parts: [{ type: "text", text }],
  }
}

function createCommandInput(sessionID: string, command: string): CommandExecuteBeforeInput {
  return {
    sessionID,
    command,
    arguments: "",
  }
}

function createCommandOutput(text: string): CommandExecuteBeforeOutput {
  return {
    parts: [{ type: "text", text }],
  }
}

describe("createAutoSlashCommandHook leak prevention", () => {
  beforeEach(() => {})

  describe("#given hook with sessionProcessedCommandExecutions", () => {
    describe("#when same command executed twice within TTL for same session", () => {
      it("#then second execution is deduplicated", async () => {
        //#given
        const nowSpy = spyOn(Date, "now")
        try {
          const hook = createHookWithSkills(["leak-test-command"])
          const input = createCommandInput("session-dedup", "leak-test-command")
          const firstOutput = createCommandOutput("first")
          const secondOutput = createCommandOutput("second")

          //#when
          nowSpy.mockReturnValue(0)
          await hook["command.execute.before"](input, firstOutput)
          nowSpy.mockReturnValue(29_999)
          await hook["command.execute.before"](input, secondOutput)

          //#then
          expect(firstOutput.parts[0].text).toContain(AUTO_SLASH_COMMAND_TAG_OPEN)
          expect(secondOutput.parts[0].text).toBe("second")
        } finally {
          nowSpy.mockRestore()
        }
      })
    })

    describe("#when same command is repeated after TTL expires", () => {
      it("#then command executes again", async () => {
        //#given
        const nowSpy = spyOn(Date, "now")
        try {
          const hook = createHookWithSkills(["leak-test-command"])
          const input = createCommandInput("session-dedup", "leak-test-command")
          const firstOutput = createCommandOutput("first")
          const secondOutput = createCommandOutput("second")

          //#when
          nowSpy.mockReturnValue(0)
          await hook["command.execute.before"](input, firstOutput)
          nowSpy.mockReturnValue(30_001)
          await hook["command.execute.before"](input, secondOutput)

          //#then
          expect(firstOutput.parts[0].text).toContain(AUTO_SLASH_COMMAND_TAG_OPEN)
          expect(secondOutput.parts[0].text).toContain(AUTO_SLASH_COMMAND_TAG_OPEN)
        } finally {
          nowSpy.mockRestore()
        }
      })
    })
  })

  describe("#given hook with entries from multiple sessions", () => {
    describe("#when dispose() is called", () => {
      it("#then both Sets are empty", async () => {
        const hook = createHookWithSkills(["leak-chat", "leak-command"])
        await hook["chat.message"](
          createChatInput("session-chat", "message-chat"),
          createChatOutput("/leak-chat")
        )
        await hook["command.execute.before"](
          createCommandInput("session-command", "leak-command"),
          createCommandOutput("before")
        )

        hook.dispose()
        const chatOutputAfterDispose = createChatOutput("/leak-chat")
        const commandOutputAfterDispose = createCommandOutput("after")
        await hook["chat.message"](
          createChatInput("session-chat", "message-chat"),
          chatOutputAfterDispose
        )
        await hook["command.execute.before"](
          createCommandInput("session-command", "leak-command"),
          commandOutputAfterDispose
        )

        expect(chatOutputAfterDispose.parts[0].text).toContain(AUTO_SLASH_COMMAND_TAG_OPEN)
        expect(commandOutputAfterDispose.parts[0].text).toContain(
          AUTO_SLASH_COMMAND_TAG_OPEN
        )
      })
    })
  })

  describe("#given Set with more than 10000 entries", () => {
    describe("#when new entry added", () => {
      it("#then Set size is reduced", { timeout: 10_000 }, async () => {
        const nowSpy = spyOn(Date, "now")
        try {
          nowSpy.mockReturnValue(0)
          const store = createProcessedCommandStore()
          const oldestKey = "session-oldest:message-oldest:leak-oldest"
          const newestKey = "session-newest:message-newest:leak-newest"

          store.add(oldestKey)

          for (let index = 0; index < 10_000; index += 1) {
            store.add(`session-${index}:message-${index}:leak-${index}`)
          }

          store.add(newestKey)

          expect(store.has(oldestKey)).toBe(false)
          expect(store.has(newestKey)).toBe(true)
        } finally {
          nowSpy.mockRestore()
        }
      })
    })
  })
})

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import type { LoadedSkill } from "../../features/opencode-skill-loader"
import * as shared from "../../shared"
import * as slashcommandTool from "../../tools/slashcommand"
import * as opencodeSkillLoader from "../../features/opencode-skill-loader"
import { executeSlashCommand } from "./executor"

function createRestrictedSkill(): LoadedSkill {
  return {
    name: "restricted-skill",
    definition: {
      name: "restricted-skill",
      description: "restricted",
      template: "restricted template",
      agent: "hephaestus",
    },
    scope: "user",
  }
}

describe("executeSlashCommand resolution semantics", () => {
  let resolveCommandsInTextSpy: ReturnType<typeof spyOn>
  let resolveFileReferencesInTextSpy: ReturnType<typeof spyOn>
  let discoverCommandsSyncSpy: ReturnType<typeof spyOn>
  let discoverAllSkillsSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    resolveCommandsInTextSpy = spyOn(
      shared,
      "resolveCommandsInText",
    ).mockImplementation(async (content: string) => content)
    resolveFileReferencesInTextSpy = spyOn(
      shared,
      "resolveFileReferencesInText",
    ).mockImplementation(async (content: string) => content)
    discoverCommandsSyncSpy = spyOn(
      slashcommandTool,
      "discoverCommandsSync",
    ).mockReturnValue([
      {
        name: "shadowed",
        metadata: { name: "shadowed", description: "builtin" },
        content: "builtin template",
        scope: "builtin",
      },
      {
        name: "shadowed",
        metadata: { name: "shadowed", description: "project" },
        content: "project template",
        scope: "project",
      },
    ])
    discoverAllSkillsSpy = spyOn(
      opencodeSkillLoader,
      "discoverAllSkills",
    ).mockResolvedValue([])
  })

  afterEach(() => {
    resolveCommandsInTextSpy?.mockRestore()
    resolveFileReferencesInTextSpy?.mockRestore()
    discoverCommandsSyncSpy?.mockRestore()
    discoverAllSkillsSpy?.mockRestore()
  })

  it("returns project command when project and builtin names collide", async () => {
    //#given
    const parsed = {
      command: "shadowed",
      args: "",
      raw: "/shadowed",
    }

    //#when
    const result = await executeSlashCommand(parsed, { skills: [] })

    //#then
    expect(result.success).toBe(true)
    expect(result.replacementText).toContain("**Scope**: project")
    expect(result.replacementText).toContain("project template")
    expect(result.replacementText).not.toContain("builtin template")
  })

  it("blocks slash skill invocation when invoking agent is missing", async () => {
    //#given
    const parsed = {
      command: "restricted-skill",
      args: "",
      raw: "/restricted-skill",
    }

    //#when
    const result = await executeSlashCommand(parsed, { skills: [createRestrictedSkill()] })

    //#then
    expect(result.success).toBe(false)
    expect(result.error).toBe('Skill "restricted-skill" is restricted to agent "hephaestus"')
  })

  it("allows slash skill invocation when invoking agent matches restriction", async () => {
    //#given
    const parsed = {
      command: "restricted-skill",
      args: "",
      raw: "/restricted-skill",
    }

    //#when
    const result = await executeSlashCommand(parsed, {
      skills: [createRestrictedSkill()],
      agent: "hephaestus",
    })

    //#then
    expect(result.success).toBe(true)
    expect(result.replacementText).toContain("restricted template")
  })
})

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import * as shared from "../../shared"
import { getLastAgentFromSession } from "./session-last-agent"

function createMockClient(messages: Array<{ info?: { agent?: string } }>) {
  return {
    session: {
      messages: async () => ({ data: messages }),
    },
  }
}

describe("getLastAgentFromSession sqlite branch", () => {
  beforeEach(() => {
    mock.restore()
    spyOn(shared, "getMessageDir").mockReturnValue(null)
    spyOn(shared, "isSqliteBackend").mockReturnValue(true)
  })

  afterEach(() => {
    mock.restore()
  })

  test("should skip compaction and return the previous real agent from sqlite messages", async () => {
    // given
    const client = createMockClient([
      { info: { agent: "atlas" } },
      { info: { agent: "compaction" } },
    ])

    // when
    const result = await getLastAgentFromSession("ses_sqlite_compaction", client)

    // then
    expect(result).toBe("atlas")
  })

  test("should return null when sqlite history contains only compaction", async () => {
    // given
    const client = createMockClient([{ info: { agent: "compaction" } }])

    // when
    const result = await getLastAgentFromSession("ses_sqlite_only_compaction", client)

    // then
    expect(result).toBeNull()
  })
})

export {}

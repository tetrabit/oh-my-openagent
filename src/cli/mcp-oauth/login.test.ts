import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test"

const mockLogin = mock(() => Promise.resolve({ accessToken: "test-token", expiresAt: 1710000000 }))

let moduleImportCounter = 0
let login: typeof import("./login").login

async function restoreActualProviderModule(): Promise<void> {
  moduleImportCounter += 1
  const providerModule = await import(`../../features/mcp-oauth/provider?restore=${moduleImportCounter}`)
  mock.restore()
  mock.module("../../features/mcp-oauth/provider", () => providerModule)
}

async function prepareLoginTestModule(): Promise<void> {
  mock.restore()
  mock.module("../../features/mcp-oauth/provider", () => ({
    McpOAuthProvider: class MockMcpOAuthProvider {
      constructor(public options: { serverUrl: string; clientId?: string; scopes?: string[] }) {}
      async login() {
        return mockLogin()
      }
    },
  }))

  moduleImportCounter += 1
  ;({ login } = await import(`./login?test=${moduleImportCounter}`))
}

describe("login command", () => {
  beforeEach(async () => {
    mockLogin.mockClear()
    await prepareLoginTestModule()
  })

  afterEach(async () => {
    await restoreActualProviderModule()
  })

  it("returns error code when server-url is not provided", async () => {
    // given
    const serverName = "test-server"
    const options = {}

    // when
    const exitCode = await login(serverName, options)

    // then
    expect(exitCode).toBe(1)
  })

  it("returns success code when login succeeds", async () => {
    // given
    const serverName = "test-server"
    const options = {
      serverUrl: "https://oauth.example.com",
    }

    // when
    const exitCode = await login(serverName, options)

    // then
    expect(exitCode).toBe(0)
    expect(mockLogin).toHaveBeenCalledTimes(1)
  })

  it("returns error code when login throws", async () => {
    // given
    const serverName = "test-server"
    const options = {
      serverUrl: "https://oauth.example.com",
    }
    mockLogin.mockRejectedValueOnce(new Error("Network error"))

    // when
    const exitCode = await login(serverName, options)

    // then
    expect(exitCode).toBe(1)
  })

  it("returns error code when server-url is missing", async () => {
    // given
    const serverName = "test-server"
    const options = {
      clientId: "test-client-id",
    }

    // when
    const exitCode = await login(serverName, options)

    // then
    expect(exitCode).toBe(1)
  })
})

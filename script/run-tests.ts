import { existsSync } from "node:fs"
import { join, relative } from "node:path"

const ROOTS = ["bin", "script", "src"] as const
const BATCH_SIZE = 100
const MOCK_MODULE_PATTERN = /\bmock\.module\s*\(/

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

async function collectTestFiles(): Promise<string[]> {
  const files: string[] = []
  const cwd = process.cwd()

  for (const root of ROOTS) {
    if (!existsSync(root)) {
      continue
    }

    for await (const relativePath of new Bun.Glob("**/*.test.ts").scan({ cwd: root })) {
      files.push(join(cwd, root, relativePath))
    }
  }

  return files.sort()
}

async function splitTestFiles(testFiles: string[]): Promise<{
  isolated: string[]
  batch: string[]
}> {
  const isolated: string[] = []
  const batch: string[] = []

  for (const testFile of testFiles) {
    const contents = await Bun.file(testFile).text()
    if (MOCK_MODULE_PATTERN.test(contents)) {
      isolated.push(testFile)
      continue
    }
    batch.push(testFile)
  }

  return { isolated, batch }
}

async function runBunTest(args: string[], label: string): Promise<void> {
  console.log(`\n[tests] ${label}`)
  const subprocess = Bun.spawn(["bun", "test", ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })

  const exitCode = await subprocess.exited
  if (exitCode !== 0) {
    process.exit(exitCode)
  }
}

const forwardedArgs = Bun.argv.slice(2)
const testFiles = await collectTestFiles()

if (testFiles.length === 0) {
  console.log("[tests] no root test files found")
  process.exit(0)
}

const { isolated, batch } = await splitTestFiles(testFiles)

for (const testFile of isolated) {
  await runBunTest(
    [...forwardedArgs, testFile],
    `isolated ${relative(process.cwd(), testFile)}`,
  )
}

const batchChunks = chunk(batch, BATCH_SIZE)

for (const [index, batchChunk] of batchChunks.entries()) {
  await runBunTest(
    [...forwardedArgs, ...batchChunk],
    `batch ${index + 1}/${batchChunks.length}`,
  )
}

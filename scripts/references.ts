#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

type ReferenceRepository = {
  readonly name: string
  readonly directory: string
  readonly url: string
}

const repositories = [
  {
    name: "Effect v4",
    directory: "effect-smol",
    url: "https://github.com/Effect-TS/effect-smol.git",
  },
] satisfies ReadonlyArray<ReferenceRepository>

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = dirname(scriptDir)
const referencesDir = join(projectRoot, ".references")

const run = (command: string, args: ReadonlyArray<string>, cwd = projectRoot) => {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

console.log("Setting up .references/ directory...")

mkdirSync(referencesDir, { recursive: true })

for (const repository of repositories) {
  const repositoryPath = join(referencesDir, repository.directory)

  if (existsSync(repositoryPath)) {
    console.log(`Pulling ${repository.name} updates...`)
    run("git", ["pull", "--ff-only"], repositoryPath)
  } else {
    console.log(`Cloning ${repository.name}...`)
    run("git", ["clone", "--depth", "1", repository.url, repository.directory], referencesDir)
  }
}

console.log("")
console.log("All reference repositories are up to date!")
console.log("")
console.log("Repositories:")
for (const entry of readdirSync(referencesDir).sort()) {
  console.log(entry)
}

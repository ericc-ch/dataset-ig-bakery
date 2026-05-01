#!/usr/bin/env node

import { Command, Flag } from "effect/unstable/cli"
import { ChildProcess } from "effect/unstable/process"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Stream } from "effect"

const runCommand = (cmd: string, args: string[]) =>
  Effect.gen(function* () {
    const handle = yield* ChildProcess.make(cmd, args)
    const chunks = yield* Stream.runCollect(handle.stdout)
    const textStream = Stream.decodeText(Stream.fromArray(chunks))
    const output = yield* Stream.runCollect(textStream)
    return output.join("").trim()
  }).pipe(Effect.scoped)

const dryRun = Flag.boolean("dry-run").pipe(
  Flag.withAlias("d"),
  Flag.withDefault(false),
  Flag.withDescription("Print release notes without creating release"),
)

const release = Command.make("release", { dryRun }, ({ dryRun }) =>
  Effect.gen(function* () {
    const currentTag = yield* runCommand("git", ["describe", "--tags", "--exact-match", "HEAD"])

    const prevTag = yield* runCommand("git", ["describe", "--tags", "--abbrev=0", `${currentTag}^`])

    const range = prevTag ? `${prevTag}..${currentTag}` : currentTag
    const notes = yield* runCommand("git", ["log", range, "--pretty=format:%s", "--no-merges"])

    yield* Effect.log(`Current tag: ${currentTag}`)
    yield* Effect.log(`Previous tag: ${prevTag}`)
    yield* Effect.log(`Range: ${range}`)
    yield* Effect.log(`Found ${notes.split("\n").length} commits`)

    if (dryRun) {
      yield* Effect.log(`Release notes: ${notes}`)
    } else {
      yield* runCommand("gh", [
        "release",
        "create",
        currentTag,
        "--title",
        currentTag,
        "--notes",
        notes,
      ])
      yield* Effect.log(`Release created: ${currentTag}`)
    }
  }),
)

const program = Command.run(release, { version: "0.0.0" })

NodeRuntime.runMain(Effect.provide(program, NodeServices.layer))

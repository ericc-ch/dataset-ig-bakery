#!/usr/bin/env node

import { Console, Effect, Layer } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { NodeRuntime, NodeServices } from "@effect/platform-node"

const name = Argument.string("name").pipe(Argument.optional)

const bold = Flag.boolean("bold").pipe(
  Flag.withAlias("b"),
  Flag.withDefault(false),
  Flag.withDescription("Print in bold"),
)

const helloCommand = Command.make(
  "hello",
  { name, bold },
  Effect.fn(function* ({ name, bold }) {
    const message = `Hello${name._tag === "Some" ? `, ${name.value}` : ""}!`
    yield* Console.log(bold ? `**${message}**` : message)
  }),
).pipe(
  Command.withDescription("Say hello"),
  Command.withExamples([
    { command: "pkg-placeholder hello", description: "Say hello" },
    { command: "pkg-placeholder hello John", description: "Say hello to John" },
    {
      command: "pkg-placeholder hello --bold",
      description: "Say hello in bold",
    },
  ]),
)

const command = Command.make("pkg-placeholder", {}).pipe(
  Command.withDescription("CLI starter template"),
  Command.withSubcommands([helloCommand]),
)

const cli = Command.run(command, { version: "0.0.1" })

const MainLayer = Layer.empty.pipe(Layer.provideMerge(NodeServices.layer))

NodeRuntime.runMain(cli.pipe(Effect.provide(MainLayer)))

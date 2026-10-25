import { describe, expect } from "bun:test"
import { Message } from "@opencode/ai/effect"
import type { SessionContext } from "@opencode/plugin/effect/session"
import { Agent } from "@opencode/core/agent"
import { Config } from "@opencode/core/config"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { WarmingPlugin } from "@opencode/core/plugin/warming"
import { Project } from "@opencode/core/project"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Document, Info } from "@opencode/schema/config"
import { Money } from "@opencode/schema/money"
import { Session } from "@opencode/schema/session"
import { DateTime, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { it } from "../lib/effect"
import { host } from "./host"

const sessionID = Session.ID.make("ses_warming_test")
const info = Session.Info.make({
  id: sessionID,
  projectID: Project.ID.global,
  cost: Money.USD.zero,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
})
const archived = { ...info, time: { ...info.time, archived: DateTime.makeUnsafe(0) } }

/** Starts the warming plugin with warming enabled and returns its context hook and the generate calls. */
const start = Effect.fnUntraced(function* (initial: Session.Info) {
  const state = { session: initial, generated: 0 }
  let context: ((input: SessionContext) => Effect.Effect<void>) | undefined
  yield* WarmingPlugin.Plugin.effect(
    host({
      session: {
        get: () => Effect.sync(() => state.session),
        generate: () =>
          Effect.sync(() => {
            state.generated++
            return { text: "OK" }
          }),
        hook: (name, callback) => {
          if (name === "context") {
            // Hook names and callbacks are correlated, but TypeScript does not narrow this generic registration API.
            // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
            context = callback as unknown as (input: SessionContext) => Effect.Effect<void>
          }
          return Effect.succeed({ dispose: Effect.void })
        },
      },
    }),
  ).pipe(
    Effect.provide(
      Layer.mock(Config.Service)({
        entries: () => Effect.succeed([new Document({ type: "document", info: new Info({ warming: true }) })]),
      }),
    ),
  )
  if (!context) return yield* Effect.die("context hook was not registered")
  const step = context
  return {
    state,
    step: () =>
      step({
        sessionID,
        agent: Agent.ID.make("build"),
        model: { id: Model.ID.make("model"), providerID: Provider.ID.make("test") },
        system: [],
        messages: [Message.user("hello")],
        tools: {},
        options: {},
      }),
  }
})

describe("WarmingPlugin", () => {
  it.effect("warms a session after each idle interval", () =>
    Effect.gen(function* () {
      const warming = yield* start(info)
      yield* warming.step()

      yield* TestClock.adjust("4 minutes")
      yield* TestClock.adjust("4 minutes")

      expect(warming.state.generated).toBe(2)
    }),
  )

  it.effect("does not warm an archived session", () =>
    Effect.gen(function* () {
      const warming = yield* start(archived)
      yield* warming.step()

      yield* TestClock.adjust("30 minutes")

      expect(warming.state.generated).toBe(0)
    }),
  )

  it.effect("stops warming a session once it is archived", () =>
    Effect.gen(function* () {
      const warming = yield* start(info)
      yield* warming.step()
      yield* TestClock.adjust("4 minutes")
      expect(warming.state.generated).toBe(1)

      warming.state.session = archived
      yield* TestClock.adjust("4 minutes")
      warming.state.session = info
      yield* TestClock.adjust("30 minutes")

      expect(warming.state.generated).toBe(1)
    }),
  )
})

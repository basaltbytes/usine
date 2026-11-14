import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  AgentSessionId,
  type AgentSessionEvent,
  RoleName,
  RoleSession,
} from "@usine/core/agent/session";
import { Effect, Fiber, Option, Result, Stream } from "effect";
import { admitBrain, AdmissionContext } from "../../src/harness/admission.ts";
import { catalog } from "../../src/harness/catalog.ts";
import { RolePlacements, RoleSpec } from "../../src/harness/role.ts";
import { claudeRuntime } from "../../src/harness/claude/claude.ts";
import { codexRuntime } from "../../src/harness/codex/codex.ts";
import { continuationPolicy } from "../../src/harness/continuation.ts";
import { SessionSpec, StartPrompt } from "../../src/harness/contract.ts";
import { RestartState } from "../../src/runtime.ts";
import { openFixture, providers } from "./fixture.ts";

const prompt = "Reply with exactly REPLAY_DONE. Do not use tools.";
const probe = RoleSpec.make({
  name: RoleName.make("contract-probe"),
  placement: RolePlacements.make({
    placements: ["local"],
    reason: "The contract probe runs on the local worker",
  }),
  credential: Option.none(),
  nativeTools: "all",
  hostTools: false,
  persistence: "saved",
  interventions: true,
  output: "text",
});

describe("role-neutral harness runtimes", () => {
  for (const provider of providers)
    it.live(
      `${provider}: opens a role session from a session spec over the recorded traffic`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fixture = yield* openFixture(provider, "simple", "replay");
            assert("harness" in fixture, "the simple scenario replays through the runtime layers");
            const { host, worker, machine, cwd, environment } = fixture.request;
            const session = RoleSession.make({
              // The recorded traffic names the session in process and pid file paths.
              id: AgentSessionId.make("replay-parent:child:1"),
              role: probe.name,
              agent: fixture.request.session.agent,
              brain: fixture.request.session.brain,
            });
            const admitted = admitBrain(
              catalog,
              probe,
              session.brain,
              AdmissionContext.make({ placement: "local", credential: "gateway-subscription" }),
            );
            assert(Result.isSuccess(admitted));
            const spec = SessionSpec.make({
              session,
              admitted: admitted.success,
              host,
              worker,
              machine,
              cwd,
              environment,
            });
            const { message, events } = yield* Effect.gen(function* () {
              const runtime = yield* provider === "claude" ? claudeRuntime : codexRuntime;
              const policy = yield* continuationPolicy(spec, prompt, RestartState.make({}));
              const native = yield* runtime.open(spec, StartPrompt.make({ text: prompt }), policy);
              const collected = yield* Effect.forkScoped(Stream.runCollect(native.running.events));
              const result = yield* native.running.result;
              return {
                message: result.message,
                events: yield* Fiber.join(collected),
              };
            }).pipe(Effect.scoped, Effect.provide(fixture.harness), fixture.tape.guard);
            assert.include(message, "REPLAY_DONE");
            const started = events.find(
              (event): event is Extract<AgentSessionEvent, { _tag: "SessionStarted" }> =>
                event._tag === "SessionStarted",
            );
            assert(started !== undefined);
            assert(started.session._tag === "RoleSession");
            assert.strictEqual(started.session.role, "contract-probe");
            assert.deepStrictEqual(started.session.parentId, Option.none());
            assert.deepStrictEqual(
              started.session.pool,
              Option.some(provider === "claude" ? "claudePlan" : "chatgptPlan"),
            );
            assert.isAbove(events.length, 2, "the replay emits content events after the start");
            for (const event of events) {
              assert(event.session._tag === "RoleSession", `${event._tag} keeps the role session`);
              assert.deepStrictEqual(event.session.pool, started.session.pool, event._tag);
            }
            assert.strictEqual(events.at(-1)?._tag, "SessionFinished");
            yield* fixture.save;
          }),
        ).pipe(Effect.provide(NodeServices.layer), Effect.timeout("15 seconds")),
      20_000,
    );
});

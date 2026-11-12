import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId, type AgentSessionEvent } from "@usine/core/agent/session";
import { WorkerName } from "@usine/core/worker";
import { Effect, Layer, Option, Result } from "effect";
import { LocalProcess } from "../../src/child-host/child-host.ts";
import { catalog } from "../../src/harness/catalog.ts";
import { codex } from "../../src/harness/codex/descriptor.ts";
import { HarnessCatalog } from "../../src/harness/harness.ts";
import { Harnesses } from "../../src/harness/registry.ts";
import { admitSupervisor, supervisor } from "../../src/harness/supervisor/role.ts";
import {
  runSupervisorTurn,
  SupervisorSeat,
  SupervisorTurn,
} from "../../src/harness/supervisor/turn.ts";
import { WorkingDirectory } from "../../src/runtime.ts";
import { assertProvenCapabilities } from "./capabilities.ts";
import { listedTools, toolProviders } from "./host-tools.ts";
import {
  operatorToolHandlers,
  operatorTools,
  RESUMED,
  runSupervisorScenario,
  supervisorMessages,
  WAITING_RUN,
} from "./supervisor.ts";

/** The names under which `provider` lists the toolkit's tools, sorted. */
const operatorNames = (provider: (typeof toolProviders)[number]) =>
  Object.keys(operatorTools.tools)
    .map((name) => (provider === "claude" ? `mcp__usine__${name}` : name))
    .sort();

const started = (events: ReadonlyArray<AgentSessionEvent>) =>
  events.flatMap((event) => (event._tag === "ToolStarted" ? [event.tool] : []));
const finished = (events: ReadonlyArray<AgentSessionEvent>) =>
  events.flatMap((event) =>
    event._tag === "ToolFinished" ? [{ tool: event.tool, isError: event.isError }] : [],
  );

describe("the supervisor role", () => {
  for (const provider of toolProviders)
    it.live(
      `${provider}: lists only the operator tools, calls one, and resumes the session`,
      () =>
        Effect.gen(function* () {
          const { replies, entries } = yield* runSupervisorScenario(provider, "replay");
          const [first, second] = replies;
          assert.include(first.message, WAITING_RUN);
          assert.deepStrictEqual(started(first.events), ["overview"]);
          assert.deepStrictEqual(finished(first.events), [{ tool: "overview", isError: false }]);
          assert.strictEqual(first.events.at(-1)?._tag, "SessionFinished");

          const listed = listedTools(provider, entries);
          assert.isNotEmpty(listed, "the recorded traffic shows the session's tool list");
          for (const offered of listed)
            assert.deepStrictEqual(
              [...offered].sort(),
              operatorNames(provider),
              "the session lists the operator tools and no harness tool",
            );

          assert.include(second.message, WAITING_RUN, "the second turn recalls the first");
          assert.include(second.message, RESUMED);
          assert.deepStrictEqual(started(second.events), []);
          assert.strictEqual(
            second.saved.id,
            first.saved.id,
            "the second turn reopens the session",
          );
          const reopened = second.events.find((event) => event._tag === "SessionStarted");
          assert(reopened?._tag === "SessionStarted");
          assert.deepStrictEqual(
            Option.map(reopened.harnessSession, ({ id }) => id),
            Option.some(first.saved.id),
          );

          for (const reply of replies) {
            assert(Option.isSome(reply.usage), "each turn reports the session's usage");
            const { session, totalTokens } = reply.usage.value;
            assert(session._tag === "RoleSession");
            assert.strictEqual(session.role, supervisor.name);
            assert.strictEqual(session.id, "replay-parent:child:1");
            assert.isAbove(totalTokens, 0);
            for (const event of reply.events)
              assert(event.session._tag === "RoleSession", `${event._tag} keeps the role session`);
            assertProvenCapabilities(Harness.make(provider), "supervisor", reply.events);
          }
        }).pipe(Effect.provide(NodeServices.layer), Effect.timeout("20 seconds")),
      30_000,
    );

  it.effect("codex: the descriptor refuses the role until Codex serves usine tool sets", () =>
    Effect.gen(function* () {
      const brain = BrainSpec.make({
        harness: Harness.make("codex"),
        model: ModelId.make("gpt-5.6-terra"),
        effort: "low",
      });
      const refused = admitSupervisor(catalog, brain, "gateway");
      assert(Result.isFailure(refused));
      const usineTools = codex.capabilities
        .flatMap(({ lacking }) => lacking)
        .find(({ capability }) => capability === "usine-tools");
      assert(usineTools !== undefined);
      assert.deepStrictEqual(
        refused.failure.missing.map(({ capability }) => capability),
        ["usine-tools", "closed-tools"],
      );
      assert.include(refused.failure.message, `lacks usine-tools (${usineTools.reason})`);

      // The same toolkit and turn as on the other harnesses: admission refuses it before any
      // session opens.
      const unreachable = () => assert.fail("a refused supervisor turn opens no session");
      const harnesses = Harnesses.layerFrom(HarnessCatalog.make({ descriptors: [codex] }), [
        {
          id: brain.harness,
          open: unreachable,
          complete: unreachable,
          stop: unreachable,
          preflight: unreachable,
        },
      ]);
      const failure = yield* runSupervisorTurn(
        SupervisorTurn.make({
          session: AgentSessionId.make("supervisor:codex"),
          brain,
          seat: SupervisorSeat.make({
            host: LocalProcess.make(),
            worker: WorkerName.make("orchestrator"),
            cwd: WorkingDirectory.make("/tmp"),
            environment: {},
            credential: "gateway",
          }),
          saved: Option.none(),
          message: supervisorMessages[0],
        }),
        operatorTools,
      ).pipe(Effect.flip, Effect.provide(Layer.merge(operatorToolHandlers, harnesses)));
      assert.strictEqual(failure._tag, "AgentResultError");
      assert.strictEqual(failure.message, refused.failure.message);
    }),
  );
});

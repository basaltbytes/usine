import { assert, describe, it } from "@effect/vitest";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, type Harness, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  RoleName,
  RoleSession,
  SessionTokensUpdated,
  TokenCount,
} from "@usine/core/agent/session";
import { WorkerName } from "@usine/core/worker";
import { Array as Arr, Effect, Fiber, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { LocalProcess } from "../src/child-host/child-host.ts";
import { AdmissionContext, AdmittedBrain } from "../src/harness/admission.ts";
import { CapabilityProfile, Lacking } from "../src/harness/capability.ts";
import { catalog } from "../src/harness/catalog.ts";
import { claude } from "../src/harness/claude/descriptor.ts";
import { continuationPolicy } from "../src/harness/continuation.ts";
import { SessionSpec, StartPrompt } from "../src/harness/contract.ts";
import { HarnessCatalog, HarnessDescriptor } from "../src/harness/harness.ts";
import { Harnesses, type HarnessRuntime } from "../src/harness/node.ts";
import { RolePlacements, RoleSpec } from "../src/harness/role.ts";
import { checkedPreflight } from "../src/harness/runtime.ts";
import { RestartState, WorkingDirectory } from "../src/runtime.ts";

const Verdict = Schema.Struct({ approved: Schema.Boolean });

const decision = RoleSpec.make({
  name: RoleName.make("decision"),
  placement: RolePlacements.make({
    placements: ["local"],
    reason: "The decision follows the coding agent on its worker",
  }),
  credential: Option.none(),
  nativeTools: true,
  hostTools: false,
  persistence: "ephemeral",
  interventions: false,
  output: "structured",
});

const specFor = (role: RoleSpec, harness: Harness = claude.id) => {
  const brain = BrainSpec.make({ harness, model: ModelId.make(`${harness}-model`), effort: "low" });
  return SessionSpec.make({
    session: RoleSession.make({
      id: AgentSessionId.make("decision-1"),
      role: role.name,
      agent: AgentName.make("developer"),
      brain,
    }),
    // The registry admits the spec again, so an unchecked role reaches its refusal.
    admitted: AdmittedBrain.make({
      role,
      brain,
      context: AdmissionContext.make({ placement: "local", credential: "host-login" }),
      pool: Option.none(),
    }),
    host: LocalProcess.make(),
    worker: WorkerName.make("worker-1"),
    machine: Option.none(),
    cwd: WorkingDirectory.make("/workspace/repo"),
    environment: {
      HOME: "/home/worker",
      PATH: "/usr/bin:/bin",
      CODEX_HOME: "/worker/codex",
      CLAUDE_CONFIG_DIR: "/worker/claude",
    },
  });
};

/** Runtimes for every catalog harness whose completion is `complete`, recording each call. */
const runtimesWith = (complete: HarnessRuntime["complete"]) => {
  const calls: Array<SessionSpec> = [];
  const runtimes = catalog.ids.map((id): HarnessRuntime => ({
    id,
    preflight: checkedPreflight(() => Effect.void),
    stop: () => Effect.void,
    open: () => Effect.die(new Error("The test opens no session")),
    complete: (spec, prompt, output) =>
      Effect.sync(() => calls.push(spec)).pipe(Effect.andThen(complete(spec, prompt, output))),
  }));
  return { calls, runtimes };
};

const answering = () =>
  runtimesWith((spec, _prompt, output) =>
    Schema.decodeEffect(output)({ approved: true }).pipe(
      Effect.orDie,
      Effect.map((value) => ({
        value,
        usage: SessionTokensUpdated.make({
          session: spec.session,
          totalTokens: TokenCount.make(3),
        }),
      })),
    ),
  );

describe("structured completions through the registry", () => {
  it.effect("admits a completion and runs it with only its harness's host variables", () => {
    const { calls, runtimes } = answering();
    return Effect.gen(function* () {
      const harnesses = yield* Harnesses;
      const runtime = yield* harnesses.runtime(claude.id);
      const completion = yield* runtime.complete(specFor(decision), "Approve?", Verdict);
      assert.deepStrictEqual(completion.value, { approved: true });
      assert.deepStrictEqual(
        calls.map(({ environment }) => environment),
        [{ HOME: "/home/worker", PATH: "/usr/bin:/bin", CLAUDE_CONFIG_DIR: "/worker/claude" }],
      );
    }).pipe(Effect.provide(Harnesses.layerFrom(catalog, runtimes)));
  });

  it.effect("refuses a completion for a role that keeps its conversation or returns text", () => {
    const { calls, runtimes } = runtimesWith(() => Effect.die(new Error("unreachable")));
    return Effect.gen(function* () {
      const runtime = yield* (yield* Harnesses).runtime(claude.id);
      for (const role of [
        RoleSpec.make({ ...decision, persistence: "saved" }),
        RoleSpec.make({ ...decision, output: "text" }),
      ]) {
        const refused = yield* runtime
          .complete(specFor(role), "Approve?", Verdict)
          .pipe(Effect.flip);
        assert.strictEqual(refused._tag, "CompletionRefused");
      }
      const scalar = yield* runtime
        .complete(specFor(decision), "Approve?", Schema.Boolean)
        .pipe(Effect.flip);
      assert.strictEqual(scalar._tag, "CompletionRefused");
      assert.include(scalar.message, "JSON object");
      assert.deepStrictEqual(calls, []);
    }).pipe(Effect.provide(Harnesses.layerFrom(catalog, runtimes)));
  });

  it.effect("refuses a completion on a harness whose descriptor lacks structured output", () => {
    const { calls, runtimes } = runtimesWith(() => Effect.die(new Error("unreachable")));
    const unstructured = HarnessDescriptor.make({
      ...claude,
      capabilities: Arr.map(claude.capabilities, (profile) =>
        CapabilityProfile.make({
          ...profile,
          supported: profile.supported.filter((capability) => capability !== "structured-output"),
          lacking: [
            ...profile.lacking,
            Lacking.make({ capability: "structured-output", reason: "No output schema" }),
          ],
        }),
      ),
    });
    const source = HarnessCatalog.make({
      descriptors: catalog.descriptors.map((descriptor) =>
        descriptor.id === claude.id ? unstructured : descriptor,
      ),
    });
    return Effect.gen(function* () {
      const runtime = yield* (yield* Harnesses).runtime(claude.id);
      const refused = yield* runtime
        .complete(specFor(decision), "Approve?", Verdict)
        .pipe(Effect.flip);
      assert.strictEqual(refused._tag, "CompletionRefused");
      assert.include(refused.message, "lacks structured-output (No output schema)");
      assert.deepStrictEqual(calls, []);
    }).pipe(Effect.provide(Harnesses.layerFrom(source, runtimes)));
  });

  it.effect("refuses to open a session for a role that runs as a completion", () =>
    Effect.gen(function* () {
      const runtime = yield* (yield* Harnesses).runtime(claude.id);
      const spec = specFor(decision);
      const policy = yield* continuationPolicy(spec, "Approve?", RestartState.make({}));
      const refused = yield* runtime
        .open(spec, StartPrompt.make({ text: "Approve?" }), policy)
        .pipe(Effect.scoped, Effect.flip);
      assert.strictEqual(refused._tag, "AgentResultError");
      assert.include(refused.message, "runs as a completion");
    }).pipe(Effect.provide(Harnesses.layerFrom(catalog, answering().runtimes))),
  );

  it.effect("fails a completion that returns nothing within ten minutes", () => {
    const { runtimes } = runtimesWith(() => Effect.never);
    return Effect.gen(function* () {
      const runtime = yield* (yield* Harnesses).runtime(claude.id);
      const fiber = yield* runtime
        .complete(specFor(decision), "Approve?", Verdict)
        .pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("10 minutes");
      const failure = yield* Fiber.join(fiber);
      assert.strictEqual(failure._tag, "SessionOperationError");
      assert.include(failure.message, "no completion within 10 minutes");
    }).pipe(Effect.provide(Harnesses.layerFrom(catalog, runtimes)));
  });
});

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
import { Array as Arr, Effect, Fiber, Option, Predicate, Schema } from "effect";
import { TestClock } from "effect/testing";
import { LocalProcess } from "../src/child-host/child-host.ts";
import { AdmissionContext, AdmittedBrain } from "../src/harness/admission.ts";
import { CapabilityProfile, Lacking } from "../src/harness/capability.ts";
import { catalog } from "../src/harness/catalog.ts";
import {
  CompletionReply,
  type CompletionRequest,
  type CompletionSchema,
  type HarnessCompletionError,
  structuredCompletion,
} from "../src/harness/completion.ts";
import { claude } from "../src/harness/claude/descriptor.ts";
import { continuationPolicy } from "../src/harness/continuation.ts";
import { SessionSpec, StartPrompt } from "../src/harness/contract.ts";
import { HarnessCatalog, HarnessDescriptor } from "../src/harness/harness.ts";
import { Harnesses, type HarnessRuntime } from "../src/harness/node.ts";
import { pi } from "../src/harness/pi/descriptor.ts";
import { RolePlacements, RoleSpec } from "../src/harness/role.ts";
import { checkedPreflight } from "../src/harness/runtime.ts";
import {
  AgentCapacityError,
  AgentResultError,
  PoolUnavailableError,
  RestartState,
  SessionOperationError,
  UnknownModelError,
  UnsupportedEffortError,
  WorkingDirectory,
} from "../src/runtime.ts";
import { isJsonObject } from "./replay/transcript.ts";

const Verdict = Schema.Struct({ approved: Schema.Boolean });

class VerdictClass extends Schema.Class<VerdictClass, { readonly brand: unique symbol }>(
  "VerdictClass",
)({
  approved: Schema.Boolean,
}) {}

class NestedVerdict extends Schema.Class<NestedVerdict, { readonly brand: unique symbol }>(
  "NestedVerdict",
)({
  verdict: VerdictClass,
  note: Schema.String,
}) {}

interface Tree {
  readonly label: string;
  readonly children: ReadonlyArray<Tree>;
}
const Tree = Schema.Struct({
  label: Schema.String,
  children: Schema.Array(Schema.suspend((): Schema.Codec<Tree> => Tree)),
}).annotate({ identifier: "Tree" });

/** Every `$ref` in `schema`, at any depth. */
const referencesIn = (schema: Schema.Json): ReadonlyArray<string> =>
  Array.isArray(schema)
    ? schema.flatMap(referencesIn)
    : isJsonObject(schema)
      ? Object.entries(schema).flatMap(([key, value]) =>
          key === "$ref" && Predicate.isString(value) ? [value] : referencesIn(value),
        )
      : [];

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
        RoleSpec.make({ ...decision, persistence: "journaled" }),
        RoleSpec.make({ ...decision, output: "text" }),
      ]) {
        const refused = yield* runtime
          .complete(specFor(role), "Approve?", Verdict)
          .pipe(Effect.flip);
        assert.strictEqual(refused.reason._tag, "CompletionRefused");
        assert.include(
          refused.message,
          "must return a structured value and keep no conversation",
          `${role.persistence} ${role.output}`,
        );
        assert.deepStrictEqual(refused.usage, Option.none());
      }
      const scalar = yield* runtime
        .complete(specFor(decision), "Approve?", Schema.Boolean)
        .pipe(Effect.flip);
      assert.strictEqual(scalar.reason._tag, "CompletionRefused");
      assert.include(scalar.message, "JSON object");
      assert.deepStrictEqual(calls, []);
    }).pipe(Effect.provide(Harnesses.layerFrom(catalog, runtimes)));
  });

  it.effect("refuses a completion for a role that runs a usine tool set", () => {
    const { calls, runtimes } = answering();
    return Effect.gen(function* () {
      const harnesses = yield* Harnesses;
      for (const harness of [claude.id, pi.id]) {
        const runtime = yield* harnesses.runtime(harness);
        for (const role of [
          RoleSpec.make({ ...decision, hostTools: true }),
          RoleSpec.make({ ...decision, hostTools: true, nativeTools: false }),
        ]) {
          const refused = yield* runtime
            .complete(specFor(role, harness), "Approve?", Verdict)
            .pipe(Effect.flip);
          assert.strictEqual(refused.reason._tag, "CompletionRefused", harness);
          assert.include(
            refused.message,
            "runs a usine tool set, but a completion serves no usine tools",
            harness,
          );
          assert.deepStrictEqual(refused.usage, Option.none());
        }
        const closed = yield* runtime.complete(
          specFor(RoleSpec.make({ ...decision, nativeTools: false }), harness),
          "Approve?",
          Verdict,
        );
        assert.deepStrictEqual(closed.value, { approved: true }, harness);
      }
      assert.deepStrictEqual(
        calls.map(({ session }) => session.brain.harness),
        [claude.id, pi.id],
      );
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
      assert.strictEqual(refused.reason._tag, "CompletionRefused");
      assert.include(refused.message, "lacks structured-output (No output schema)");
      assert.deepStrictEqual(calls, []);
    }).pipe(Effect.provide(Harnesses.layerFrom(source, runtimes)));
  });

  it.effect(
    "refuses to open a session for a role that keeps no conversation or returns a value",
    () =>
      Effect.gen(function* () {
        const runtime = yield* (yield* Harnesses).runtime(claude.id);
        for (const role of [
          decision,
          RoleSpec.make({ ...decision, output: "text" }),
          RoleSpec.make({ ...decision, persistence: "saved" }),
        ]) {
          const spec = specFor(role);
          const policy = yield* continuationPolicy(spec, "Approve?", RestartState.make({}));
          const refused = yield* runtime
            .open(spec, StartPrompt.make({ text: "Approve?" }), policy)
            .pipe(Effect.scoped, Effect.flip);
          assert.strictEqual(refused._tag, "AgentResultError");
          assert.include(
            refused.message,
            "a session always saves its conversation and returns text",
            `${role.persistence} ${role.output}`,
          );
        }
      }).pipe(Effect.provide(Harnesses.layerFrom(catalog, answering().runtimes))),
  );
});

/** Runtimes whose completion is the shared seam over `run`, recording each JSON Schema sent. */
const seamWith = (
  run: (request: CompletionRequest) => Effect.Effect<CompletionReply, HarnessCompletionError>,
) => {
  const schemas: Array<CompletionSchema> = [];
  const complete = structuredCompletion((request) =>
    Effect.sync(() => schemas.push(request.schema)).pipe(Effect.andThen(run(request))),
  );
  const runtimes = catalog.ids.map((id): HarnessRuntime => ({
    id,
    preflight: checkedPreflight(() => Effect.void),
    stop: () => Effect.void,
    open: () => Effect.die(new Error("The test opens no session")),
    complete,
  }));
  return { schemas, runtimes };
};

/** Reports the usage of a request that spent `tokens`, then answers with `reply`. */
const spending =
  (
    tokens: number,
    reply: (request: CompletionRequest) => Effect.Effect<CompletionReply, HarnessCompletionError>,
  ) =>
  (request: CompletionRequest) =>
    request
      .spent(
        SessionTokensUpdated.make({
          session: request.spec.session,
          totalTokens: TokenCount.make(tokens),
        }),
      )
      .pipe(Effect.andThen(reply(request)));

describe("the structured completion seam", () => {
  it.effect("sends the root definition of an identified output schema", () => {
    const { schemas, runtimes } = seamWith(
      spending(5, () => Effect.succeed(CompletionReply.Value({ value: { approved: true } }))),
    );
    return Effect.gen(function* () {
      const runtime = yield* (yield* Harnesses).runtime(claude.id);
      const completion = yield* runtime.complete(specFor(decision), "Approve?", VerdictClass);
      assert.instanceOf(completion.value, VerdictClass);
      assert.isTrue(completion.value.approved);
      const named = yield* runtime.complete(
        specFor(decision),
        "Approve?",
        Verdict.annotate({ identifier: "Verdict" }),
      );
      assert.deepStrictEqual(named.value, { approved: true });
      assert.strictEqual(completion.usage.totalTokens, 5);
      for (const schema of schemas) {
        assert.strictEqual(schema.type, "object");
        assert.deepStrictEqual(schema.required, ["approved"]);
        assert.strictEqual(schema.additionalProperties, false);
        assert.isUndefined(schema.$ref);
      }
      assert.strictEqual(schemas.length, 2);
    }).pipe(Effect.provide(Harnesses.layerFrom(catalog, runtimes)));
  });

  it.effect("keeps the definitions that a nested or recursive output schema references", () => {
    const { schemas, runtimes } = seamWith(
      spending(5, (request) =>
        Effect.succeed(
          CompletionReply.Value({
            value:
              request.prompt === "Approve?"
                ? { verdict: { approved: true }, note: "Looks right" }
                : { label: "root", children: [{ label: "leaf", children: [] }] },
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const runtime = yield* (yield* Harnesses).runtime(claude.id);
      const nested = yield* runtime.complete(specFor(decision), "Approve?", NestedVerdict);
      assert.instanceOf(nested.value.verdict, VerdictClass);
      const tree = yield* runtime.complete(specFor(decision), "Classify?", Tree);
      assert.deepStrictEqual(tree.value.children[0]?.label, "leaf");
      assert.strictEqual(schemas.length, 2);
      for (const schema of schemas) {
        assert.strictEqual(schema.type, "object");
        const references = referencesIn(schema);
        assert.isNotEmpty(references, "the schema references a definition");
        const definitions = schema.$defs;
        assert(
          definitions !== undefined && isJsonObject(definitions) && !Array.isArray(definitions),
          "the schema sends its definitions",
        );
        for (const reference of references) {
          assert(reference.startsWith("#/$defs/"), reference);
          assert.property(definitions, reference.slice("#/$defs/".length), reference);
        }
      }
    }).pipe(Effect.provide(Harnesses.layerFrom(catalog, runtimes)));
  });

  it.effect(
    "fails a completion that answers nothing within ten minutes with the tokens spent",
    () => {
      const { runtimes } = seamWith(spending(50_000, () => Effect.never));
      return Effect.gen(function* () {
        const runtime = yield* (yield* Harnesses).runtime(claude.id);
        const fiber = yield* runtime
          .complete(specFor(decision), "Approve?", Verdict)
          .pipe(Effect.flip, Effect.forkChild);
        yield* TestClock.adjust("10 minutes");
        const failure = yield* Fiber.join(fiber);
        assert.strictEqual(failure.reason._tag, "SessionOperationError");
        assert.include(failure.message, "no completion within 10 minutes");
        assert(Option.isSome(failure.usage), "the timeout carries the tokens spent");
        assert.strictEqual(failure.usage.value.totalTokens, 50_000);
      }).pipe(Effect.provide(Harnesses.layerFrom(catalog, runtimes)));
    },
  );

  const brain = { harness: claude.id, model: ModelId.make("claude-model") };
  const sessionId = Option.some(AgentSessionId.make("decision-1"));
  const outcomes: ReadonlyArray<{
    readonly outcome: string;
    readonly reply: Effect.Effect<CompletionReply, HarnessCompletionError>;
    readonly reason: string;
  }> = [
    {
      outcome: "an unknown model",
      reply: Effect.fail(UnknownModelError.make({ ...brain, message: "No such model" })),
      reason: "CompletionRefused",
    },
    {
      outcome: "an unsupported effort",
      reply: Effect.fail(
        UnsupportedEffortError.make({
          ...brain,
          effort: "low",
          message: "The model doesn't reason",
        }),
      ),
      reason: "CompletionRefused",
    },
    {
      outcome: "an unavailable pool",
      reply: Effect.fail(
        PoolUnavailableError.make({
          ...brain,
          pool: "apiKeys",
          message: "No API key",
        }),
      ),
      reason: "CompletionRefused",
    },
    {
      outcome: "a failed result",
      reply: Effect.fail(AgentResultError.make({ sessionId, message: "The turn failed" })),
      reason: "SessionOperationError",
    },
    {
      outcome: "a capacity refusal",
      reply: Effect.fail(AgentCapacityError.make({ sessionId, message: "Overloaded" })),
      reason: "AgentCapacityError",
    },
    {
      outcome: "a transport failure",
      reply: Effect.fail(
        SessionOperationError.make({
          operation: "stream",
          sessionId,
          message: "Output closed",
          cause: new Error("closed"),
        }),
      ),
      reason: "SessionOperationError",
    },
    {
      outcome: "a declined answer",
      reply: Effect.succeed(CompletionReply.Declined({ message: "I can't help with that" })),
      reason: "CompletionRefused",
    },
    {
      outcome: "no value",
      reply: Effect.succeed(CompletionReply.Missing({ message: "No value" })),
      reason: "CompletionInvalid",
    },
    {
      outcome: "a final answer that isn't JSON",
      reply: Effect.succeed(CompletionReply.Answer({ text: "Approved." })),
      reason: "CompletionInvalid",
    },
    {
      outcome: "a property that the schema doesn't model",
      reply: Effect.succeed(CompletionReply.Value({ value: { approved: true, extra: "x" } })),
      reason: "CompletionInvalid",
    },
  ];

  for (const { outcome, reply, reason } of outcomes)
    it.effect(`fails ${outcome} with ${reason} and the tokens spent`, () => {
      const { runtimes } = seamWith(spending(7, () => reply));
      return Effect.gen(function* () {
        const runtime = yield* (yield* Harnesses).runtime(claude.id);
        const failure = yield* runtime
          .complete(specFor(decision), "Approve?", Verdict)
          .pipe(Effect.flip);
        assert.strictEqual(failure.reason._tag, reason);
        assert.strictEqual(failure.message, failure.reason.message);
        assert(Option.isSome(failure.usage), "the failure carries the tokens spent");
        assert.strictEqual(failure.usage.value.totalTokens, 7);
      }).pipe(Effect.provide(Harnesses.layerFrom(catalog, runtimes)));
    });

  it.effect("decodes a final answer whose text is the value", () => {
    const { runtimes } = seamWith(
      spending(2, () => Effect.succeed(CompletionReply.Answer({ text: `{"approved":false}` }))),
    );
    return Effect.gen(function* () {
      const runtime = yield* (yield* Harnesses).runtime(claude.id);
      const completion = yield* runtime.complete(specFor(decision), "Approve?", Verdict);
      assert.deepStrictEqual(completion.value, { approved: false });
      assert.strictEqual(completion.usage.totalTokens, 2);
    }).pipe(Effect.provide(Harnesses.layerFrom(catalog, runtimes)));
  });
});

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import type { BillingPool } from "@usine/core/agent/session";
import { Effect, Option, Predicate, Result, type Schema, type Scope } from "effect";
import { openCompletionFixture, recordedValues } from "../replay/completion.ts";
import type { Provider } from "../replay/fixture.ts";
import { isJsonObject, type Transcript } from "../replay/transcript.ts";

const harnesses: ReadonlyArray<Provider> = ["claude", "codex", "pi"];

/** The pool that each fixture's credential route resolves. */
const pools = {
  claude: "claudePlan",
  codex: "chatgptPlan",
  pi: "apiKeys",
} satisfies Record<Provider, BillingPool>;

/** Rewrites every string that `rewrite` changes in the harness output of `transcript`. */
const rewriteOutput =
  (rewrite: (text: string) => string) =>
  (transcript: Transcript): Transcript => {
    const walk = (value: Schema.Json): Schema.Json =>
      Predicate.isString(value)
        ? rewrite(value)
        : Array.isArray(value)
          ? value.map(walk)
          : isJsonObject(value)
            ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]))
            : value;
    return {
      ...transcript,
      entries: transcript.entries.map((entry) =>
        entry.type === "emit_inbound" ? { ...entry, payload: walk(entry.payload) } : entry,
      ),
    };
  };

/** The recorded answer with a label outside the schema's literals, at the same byte length. */
const mislabelled = rewriteOutput((text) => text.replaceAll("fruit", "mango"));

const replay = <A, E>(test: Effect.Effect<A, E, Scope.Scope | NodeServices.NodeServices>) =>
  test.pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.timeout("15 seconds"));

describe("structured completion contract", () => {
  for (const harness of harnesses) {
    it.live(
      `${harness}: structured-result decodes the recorded value`,
      () =>
        replay(
          Effect.gen(function* () {
            const fixture = yield* openCompletionFixture(harness, "structured-result", "replay");
            const completion = yield* fixture.run;
            assert(Result.isSuccess(completion), "the recorded value decodes");
            assert.deepStrictEqual(completion.success.value, recordedValues["structured-result"]);
            const { usage } = completion.success;
            assert.isAbove(usage.totalTokens, 0, "the completion reports its tokens");
            assert.deepStrictEqual(usage.session.pool, Option.some(pools[harness]));
            assert.strictEqual(usage.session._tag, "RoleSession");
            yield* fixture.save;
          }),
        ),
      20_000,
    );

    it.live(
      `${harness}: structured-result fails with CompletionInvalid for a value the schema rejects`,
      () =>
        replay(
          Effect.gen(function* () {
            const fixture = yield* openCompletionFixture(harness, "structured-result", "replay", {
              transform: mislabelled,
            });
            const completion = yield* fixture.run;
            assert(Result.isFailure(completion), "a mislabelled value doesn't decode");
            assert.strictEqual(completion.failure._tag, "CompletionInvalid");
            yield* fixture.save;
          }),
        ),
      20_000,
    );

    it.live(
      `${harness}: ephemeral saves no conversation and returns no session reference`,
      () =>
        replay(
          Effect.gen(function* () {
            const fixture = yield* openCompletionFixture(harness, "ephemeral", "replay");
            const completion = yield* fixture.run;
            assert(Result.isSuccess(completion));
            assert.deepStrictEqual(completion.success.value, recordedValues.ephemeral);
            yield* fixture.save;
          }),
        ),
      20_000,
    );
  }

  it.live(
    "claude: a result past the structured output retries fails with CompletionInvalid",
    () =>
      replay(
        Effect.gen(function* () {
          const fixture = yield* openCompletionFixture("claude", "structured-result", "replay", {
            transform: (transcript) => ({
              ...transcript,
              entries: transcript.entries.map((entry) =>
                entry.type === "emit_inbound" &&
                isJsonObject(entry.payload) &&
                entry.payload.type === "result"
                  ? {
                      ...entry,
                      payload: {
                        ...entry.payload,
                        subtype: "error_max_structured_output_retries",
                        is_error: true,
                        structured_output: null,
                      },
                    }
                  : entry,
              ),
            }),
          });
          const completion = yield* fixture.run;
          assert(Result.isFailure(completion));
          assert.strictEqual(completion.failure._tag, "CompletionInvalid");
          yield* fixture.save;
        }),
      ),
    20_000,
  );
});

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import { openFixture, providers, scenarios, recordingPid } from "./fixture.ts";
import { ChildRequest } from "../../src/runtime.ts";
import { Tape } from "./transcript.ts";
import { decodeWire, encodeWire } from "./process.ts";
import { Base64 } from "effect/encoding";
import { runScenario } from "./scenarios.ts";

describe("recorded harness transports", () => {
  for (const provider of providers)
    for (const scenario of scenarios) {
      it.live(
        `${provider}: ${scenario}`,
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const fixture = yield* openFixture(provider, scenario, "replay");
              yield* runScenario(scenario, fixture.request, fixture.controls).pipe(
                Effect.provide(fixture.backend),
                fixture.tape.guard,
              );
              yield* fixture.save;
            }),
          ).pipe(Effect.provide(NodeServices.layer)),
        180_000,
      );
    }
});

it.live("rejects a changed outbound request through the real adapter", () =>
  Effect.gen(function* () {
    const outcome = yield* Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* openFixture("claude", "simple", "replay");
        yield* runScenario(
          "simple",
          ChildRequest.make({
            ...fixture.request,
            prompt: "This request differs from the recording.",
          }),
        ).pipe(Effect.provide(fixture.backend), fixture.tape.guard);
      }),
    ).pipe(Effect.exit);
    assert(Exit.isFailure(outcome));
    assert.include(Cause.pretty(outcome.cause), "outbound request differs");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it("redacts credential values before JSON escaping", () => {
  const tape = new Tape("record");
  const credential = 'token"with\\escapes';
  tape.bind(credential, "$TOKEN");
  assert.deepStrictEqual(
    tape.normalize({ environment: { token: credential }, args: [credential] }),
    {
      environment: { token: "$TOKEN" },
      args: ["$TOKEN"],
    },
  );
});

it("rejects empty and malformed recorder PID files before signaling a process", () => {
  for (const invalid of ["", " ", "0", "-1", "-123", "123partial", "NaN", "1.5"])
    assert.throws(() => recordingPid(invalid));
  assert.strictEqual(recordingPid("123\n"), 123);
});

it.effect("preserves UTF-8 characters split across supervisor frames", () =>
  Effect.gen(function* () {
    const encoder = new TextEncoder();
    const bytes = encoder.encode("a€𐍈z");
    for (const key of ["data", "stdout", "stderr"]) {
      for (let split = 1; split < bytes.length; split++) {
        for (const chunk of [bytes.slice(0, split), bytes.slice(split)]) {
          const frame = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            [key]: Base64.encode(chunk),
          });
          const decoded = yield* decodeWire(frame);
          const encoded = yield* encodeWire(decoded);
          assert.strictEqual(encoded, frame);
        }
      }
    }
    const tape = new Tape("record");
    tape.bind("secret", "$TOKEN");
    const partial = Uint8Array.from([...encoder.encode("secret"), 0xe2]);
    const frame = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      stdout: Base64.encode(partial),
    });
    const decoded = yield* decodeWire(frame);
    const redacted = yield* encodeWire(tape.normalize(decoded));
    const expected = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      stdout: Base64.encode(Uint8Array.from([...encoder.encode("$TOKEN"), 0xe2])),
    });
    assert.strictEqual(redacted, expected);
  }),
);

it.live(
  "reports outbound mismatches from background transports without waiting for a timeout",
  () =>
    Effect.gen(function* () {
      for (const provider of providers) {
        const outcome = yield* Effect.scoped(
          Effect.gen(function* () {
            const scenario = provider === "claude" ? "transport-loss" : "simple";
            const fixture = yield* openFixture(provider, scenario, "replay");
            if (provider === "codex") fixture.tape.bind("0.0.1", "$CHANGED_CLIENT_VERSION");
            else {
              assert(fixture.tape.source !== "record");
              const resume = Schema.decodeUnknownOption(
                Schema.Struct({ options: Schema.Struct({ resume: Schema.String }) }),
              );
              const saved = fixture.tape.source.entries.flatMap((entry) => {
                if (entry.type !== "expect_outbound") return [];
                const launch = resume(entry.payload);
                return Option.isSome(launch) ? [launch.value.options.resume] : [];
              });
              assert.lengthOf(saved, 1);
              const id = saved[0];
              assert(id !== undefined);
              fixture.tape.bind(id, "$CHANGED_RESUME_ID");
            }
            yield* runScenario(scenario, fixture.request, fixture.controls).pipe(
              Effect.provide(fixture.backend),
              fixture.tape.guard,
            );
          }),
        ).pipe(Effect.timeout("10 seconds"), Effect.exit);
        assert(Exit.isFailure(outcome));
        const failure = Cause.pretty(outcome.cause);
        assert.include(failure, "outbound request differs at transcript entry");
        assert.include(
          failure,
          provider === "claude" ? "$CHANGED_RESUME_ID" : "$CHANGED_CLIENT_VERSION",
        );
        assert.notInclude(failure, "TimeoutError");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  15_000,
);

it.live(
  "replays independent connections in either order and preserves order within a connection",
  () =>
    Effect.gen(function* () {
      const tape = new Tape({
        protocol: "claude-sdk",
        harnessVersion: "2.1.311",
        model: "recorded-model",
        scenario: "simple",
        environment: {},
        entries: [
          { type: "expect_outbound", port: "claude:1", payload: { method: "open" } },
          { type: "expect_outbound", port: "process:1", payload: { method: "spawn" } },
          { type: "emit_inbound", port: "claude:1/output", payload: "first output" },
          { type: "expect_outbound", port: "claude:1/input", payload: "guidance" },
          { type: "runtime_exit", port: "process:1/exit", code: 0, error: null },
          { type: "runtime_exit", port: "claude:1/output", code: 0, error: null },
        ],
      });
      tape.outbound("claude:1", { method: "open" });
      const output = yield* Effect.promise(() => tape.read("claude:1/output"));
      assert.deepStrictEqual(output, {
        type: "emit_inbound",
        port: "claude:1/output",
        payload: "first output",
      });
      tape.outbound("claude:1/input", "guidance");
      yield* Effect.promise(() => tape.read("claude:1/output"));
      tape.outbound("process:1", { method: "spawn" });
      yield* Effect.promise(() => tape.read("process:1/exit"));
      tape.assertComplete();

      assert(tape.source !== "record");
      const reordered = new Tape(tape.source);
      assert.throws(() => reordered.outbound("claude:1/input", "guidance"), /transcript entry 0/);
    }).pipe(Effect.timeout("2 seconds")),
);

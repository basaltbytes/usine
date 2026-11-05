import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect, Exit, Schema } from "effect";
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
              yield* runScenario(scenario, fixture.request, fixture.drop).pipe(
                Effect.provide(fixture.backend),
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
        ).pipe(Effect.provide(fixture.backend));
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

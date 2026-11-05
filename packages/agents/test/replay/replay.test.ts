import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";
import { openFixture, providers, scenarios } from "./fixture.ts";
import { ChildRequest } from "../../src/runtime.ts";
import { Tape } from "./transcript.ts";
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

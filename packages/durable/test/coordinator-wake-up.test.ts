import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Option, Schema } from "effect";

import { Complete, RetryChild } from "../src/attempt/coordinator/rules.ts";
import { RecordedDecision } from "../src/coordinator/wake-up.ts";
import { handlerSession } from "./support.ts";

const codec = Schema.toCodecJson(RecordedDecision);
const encode = Schema.encodeEffect(codec);
const decode = Schema.decodeEffect(codec);

/** The stored JSON of `handlerSession`. */
const storedSession = {
  brain: { harness: "claude", model: "claude-haiku-4-5", effort: "low" },
  route: "host-login",
  pool: "claudePlan",
  usage: { totalTokens: 1_200, costUsd: null },
};

describe("recorded decision", () => {
  it.effect("decodes a stored rule decision without a handler session", () =>
    Effect.gen(function* () {
      const stored = { decision: { _tag: "Complete" }, handler: "rule" };
      const decoded = yield* decode(stored);
      const encoded = yield* encode(decoded);

      assert.deepStrictEqual(
        decoded,
        RecordedDecision.make({ decision: Complete.make({}), handler: "rule" }),
      );
      assert.isTrue(Option.isNone(decoded.session));
      assert.deepStrictEqual(encoded, stored);
    }),
  );

  it.effect("decodes a stored model decision with its handler session", () =>
    Effect.gen(function* () {
      const stored = {
        decision: { _tag: "RetryChild", assignment: "Push the branch you committed." },
        handler: "session",
        session: storedSession,
      };
      const decoded = yield* decode(stored);
      const encoded = yield* encode(decoded);

      assert.deepStrictEqual(
        decoded,
        RecordedDecision.make({
          decision: RetryChild.make({ assignment: "Push the branch you committed." }),
          handler: "session",
          session: Option.some(handlerSession),
        }),
      );
      assert.deepStrictEqual(encoded, stored);
    }),
  );

  it("refuses a rule decision with a handler session and a model decision without one", () => {
    const refused = [
      { decision: { _tag: "Complete" }, handler: "rule", session: storedSession },
      { decision: { _tag: "Complete" }, handler: "completion" },
      { decision: { _tag: "Complete" }, handler: "session" },
    ];
    for (const stored of refused)
      assert.isTrue(
        Exit.isFailure(Schema.decodeExit(codec)(stored)),
        `${stored.handler} ${"session" in stored ? "with" : "without"} a session`,
      );
  });
});

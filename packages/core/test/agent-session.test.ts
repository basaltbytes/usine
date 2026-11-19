import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Option, Schema } from "effect";
import { AgentSession, RateLimitWindow, usedUpUntil } from "../src/agent/session.ts";

const decode = Schema.decodeUnknownEffect(Schema.toCodecJson(AgentSession));
const brain = { harness: "claude", model: "claude-sonnet-4-6", effort: "high" };

const window = (usedPercent: number, resetsAt?: string) =>
  RateLimitWindow.make({
    usedPercent,
    windowDurationMinutes: Option.none(),
    resetsAt: Option.map(Option.fromUndefinedOr(resetsAt), DateTime.makeUnsafe),
  });

describe("agent sessions", () => {
  it.effect("rejects a role name that is not kebab-case", () =>
    Effect.gen(function* () {
      for (const role of ["Decision", "decision_session", "-decision", ""]) {
        const error = yield* Effect.flip(
          decode({ _tag: "RoleSession", id: "decision-1", role, agent: "developer", brain }),
        );
        expect(error._tag).toBe("SchemaError");
      }
    }),
  );

  it.each([
    {
      name: "the latest reset among used-up windows",
      windows: [
        window(100, "2026-11-12T05:00:00Z"),
        window(120, "2026-11-15T00:00:00Z"),
        window(100, "2026-11-13T00:00:00Z"),
      ],
      expected: Option.some("2026-11-15T00:00:00.000Z"),
    },
    {
      name: "a used-up window's reset when a later window is below its allowance",
      windows: [window(100, "2026-11-12T05:00:00Z"), window(99.9, "2026-11-20T00:00:00Z")],
      expected: Option.some("2026-11-12T05:00:00.000Z"),
    },
    {
      name: "no reset when no window is used up",
      windows: [window(99, "2026-11-12T05:00:00Z")],
      expected: Option.none(),
    },
    {
      name: "no reset when a used-up window has no reset time",
      windows: [window(100, "2026-11-12T05:00:00Z"), window(100)],
      expected: Option.none(),
    },
  ])("dates used-up rate-limit windows with $name", ({ windows, expected }) => {
    expect(usedUpUntil(windows).pipe(Option.map(DateTime.formatIso))).toEqual(expected);
  });
});

import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { AgentSession } from "../src/agent/session.ts";

const decode = Schema.decodeUnknownEffect(Schema.toCodecJson(AgentSession));
const brain = { harness: "claude", model: "claude-sonnet-4-6", effort: "high" };

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
});

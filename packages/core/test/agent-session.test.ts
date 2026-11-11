import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { AgentName } from "../src/agent/agent.ts";
import { BrainSpec, Harness, ModelId } from "../src/agent/brain.ts";
import { AgentSession, AgentSessionId, RoleName, RoleSession } from "../src/agent/session.ts";

const codec = Schema.toCodecJson(AgentSession);
const decode = Schema.decodeUnknownEffect(codec);
const encode = Schema.encodeEffect(codec);
const brain = { harness: "claude", model: "claude-sonnet-4-6", effort: "high" };

describe("agent sessions", () => {
  it.effect("decodes stored parent and child sessions", () =>
    Effect.gen(function* () {
      const parent = yield* decode({
        _tag: "ParentSession",
        id: "attempt-1:parent",
        agent: "developer",
        brain: { harness: "pi", model: "openai-codex/gpt-5.5", effort: "high" },
      });
      expect(parent._tag).toBe("ParentSession");
      expect(Option.isNone(parent.pool)).toBe(true);
      const child = yield* decode({
        _tag: "ChildSession",
        id: "attempt-1:child:1",
        parentId: "attempt-1:parent",
        agent: "developer",
        brain,
        pool: "apiKeys",
        gatewayCredential: "api-key",
      });
      expect(child._tag).toBe("ChildSession");
      expect(child._tag === "ChildSession" && child.gatewayCredential).toStrictEqual(
        Option.some("api-key"),
      );
    }),
  );

  it.effect("round-trips a role session with and without a parent", () =>
    Effect.gen(function* () {
      for (const parentId of [Option.none(), Option.some(AgentSessionId.make("child-1"))]) {
        const session = RoleSession.make({
          id: AgentSessionId.make("decision-1"),
          role: RoleName.make("decision"),
          parentId,
          agent: AgentName.make("developer"),
          brain: BrainSpec.make({
            harness: Harness.make("claude"),
            model: ModelId.make("claude-sonnet-4-6"),
            effort: "high",
          }),
        });
        const encoded = yield* encode(session);
        const decoded = yield* decode(encoded);
        expect(decoded).toStrictEqual(session);
      }
    }),
  );

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

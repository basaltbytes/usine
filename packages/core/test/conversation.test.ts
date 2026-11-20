import { assert, it } from "@effect/vitest";
import { DateTime, Effect, Option, Schema } from "effect";
import {
  administratorPermissions,
  GitHubUserId,
  InstanceScope,
  PermissionGrant,
  ProjectScope,
} from "../src/access.ts";
import { AgentName } from "../src/agent/agent.ts";
import { BrainSpec, Harness, ModelId } from "../src/agent/brain.ts";
import {
  AgentSessionId,
  HarnessSession,
  RoleName,
  RoleSession,
  SessionTokensUpdated,
  TokenCount,
} from "../src/agent/session.ts";
import {
  ConversationId,
  defaultFormat,
  failTurn,
  Message,
  MemberPost,
  MessageBody,
  MessageSequence,
  posted,
  resumePoint,
  startTurn,
  succeedTurn,
  turnGrants,
  PostedWithSession,
  TurnError,
  TurnId,
  TurnMember,
} from "../src/conversation.ts";
import { OperatorLogin } from "../src/operator.ts";
import { ProjectId } from "../src/project.ts";

const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 10, 17, 9, minute));
const usage = (tokens: number) =>
  Option.some(
    SessionTokensUpdated.make({
      session: RoleSession.make({
        id: AgentSessionId.make("conversation"),
        role: RoleName.make("supervisor"),
        agent: AgentName.make("supervisor"),
        brain: BrainSpec.make({
          harness: Harness.make("pi"),
          model: ModelId.make("openai/gpt-5.6-luna"),
          effort: "low",
        }),
      }),
      totalTokens: TokenCount.make(tokens),
    }),
  );
const running = (turn: string, sequence: number) =>
  startTurn(
    posted(
      MemberPost.make({
        conversation: ConversationId.make("conversation"),
        turn: TurnId.make(turn),
        member: TurnMember.make({ id: GitHubUserId.make(1), login: OperatorLogin.make("ada") }),
        credential: PostedWithSession.make({}),
        format: defaultFormat,
        body: MessageBody.make("hello"),
        reply: defaultFormat,
        at: at(sequence),
      }),
      MessageSequence.make(sequence),
    ).turn,
    at(sequence),
  );

it("resumes from the last saved session with the usage of the last ended turn", () => {
  const first = HarnessSession.make({ cwd: "/first" });
  const turns = [
    succeedTurn(running("t1", 1), at(2), first, usage(10)),
    failTurn(running("t2", 3), at(4), TurnError.make({ message: "The model refused" }), usage(25)),
    running("t3", 5),
  ];
  assert.deepStrictEqual(resumePoint(turns), { session: Option.some(first), usage: usage(25) });
  assert.deepStrictEqual(resumePoint([]), { session: Option.none(), usage: Option.none() });
});

it("gives a turn only read on its scope, and nothing without read", () => {
  const alpha = ProjectScope.make({ project: ProjectId.make("alpha") });
  const beta = ProjectScope.make({ project: ProjectId.make("beta") });
  const granted = (permission: "read" | "operate", scope: ProjectScope) =>
    PermissionGrant.make({ permission, scope });
  const read = (scope: ProjectScope | InstanceScope) => [
    PermissionGrant.make({ permission: "read", scope }),
  ];
  assert.deepStrictEqual(turnGrants(alpha, administratorPermissions), read(alpha));
  assert.deepStrictEqual(
    turnGrants(alpha, [granted("read", alpha), granted("operate", alpha), granted("read", beta)]),
    read(alpha),
  );
  assert.deepStrictEqual(turnGrants(alpha, [granted("read", beta)]), []);
  assert.deepStrictEqual(
    turnGrants(InstanceScope.make(), administratorPermissions),
    read(InstanceScope.make()),
  );
});

it.effect("decodes an answer stored before answers kept their sources, with none", () =>
  Effect.gen(function* () {
    const stored = yield* Schema.decodeEffect(Schema.toCodecJson(Message))({
      conversation: "conversation",
      sequence: 2,
      turn: "t1",
      format: "markdown",
      body: "Nothing needs you.",
      createdAt: "2026-11-17T09:02:00.000Z",
      role: "supervisor",
    });
    assert(stored.role === "supervisor");
    assert.deepStrictEqual(stored.sources, []);
  }),
);

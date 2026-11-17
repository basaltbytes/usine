import { assert, it } from "vitest";
import { DateTime, Option, Schema } from "effect";
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
  authorityWithin,
  ConversationId,
  defaultFormat,
  failTurn,
  MemberPost,
  MessageBody,
  MessageSequence,
  posted,
  resumePoint,
  startTurn,
  succeedTurn,
  TurnAuthority,
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
        authority: TurnAuthority.make({ grants: [], operations: Option.none() }),
        format: defaultFormat,
        body: MessageBody.make("hello"),
        reply: defaultFormat,
        at: at(sequence),
      }),
      MessageSequence.make(sequence),
    ).turn,
    at(sequence),
  );

it("refuses an empty message body", () => {
  assert.isTrue(Option.isNone(Schema.decodeOption(MessageBody)("")));
  assert.isTrue(Option.isSome(Schema.decodeOption(MessageBody)({ answer: "" })));
});

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

it("bounds a turn's authority to its project and keeps the poster's operation ceiling", () => {
  const alpha = ProjectScope.make({ project: ProjectId.make("alpha") });
  const beta = ProjectScope.make({ project: ProjectId.make("beta") });
  const granted = (permission: "read" | "operate", scope: ProjectScope) =>
    PermissionGrant.make({ permission, scope });
  const admin = authorityWithin(alpha, administratorPermissions, Option.none());
  assert.deepStrictEqual(
    admin.grants.map(({ permission, scope }) => [permission, scope]),
    [
      ["read", alpha],
      ["operate", alpha],
      ["maintain", alpha],
    ],
  );
  const operator = authorityWithin(
    alpha,
    [granted("read", alpha), granted("operate", beta)],
    Option.some(["operator.overview"]),
  );
  assert.deepStrictEqual(operator.grants, [granted("read", alpha)]);
  assert.deepStrictEqual(operator.operations, Option.some(["operator.overview"]));
  assert.deepStrictEqual(
    authorityWithin(InstanceScope.make(), administratorPermissions, Option.none()).grants,
    administratorPermissions,
  );
});

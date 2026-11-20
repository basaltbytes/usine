import { assert, describe, it } from "@effect/vitest";
import { GitHubUserId, InstanceScope, ProjectScope } from "@usine/core/access";
import {
  Conversation,
  ConversationId,
  ConversationTitle,
  defaultFormat,
  TurnId,
  TurnMember,
} from "@usine/core/conversation";
import { OperatorLogin } from "@usine/core/operator";
import {
  allow,
  AllowedOnce,
  CallTarget,
  OperationCall,
  OperationName,
  PermissionRequestId,
  requested,
  settle,
} from "@usine/core/permission-request";
import { ProjectId } from "@usine/core/project";
import { RepositoryName } from "@usine/core/repository";
import { DateTime, Effect, Option, Schema } from "effect";
import { OUTCOMES_LIMIT, turnPrompt } from "../../src/conversation/context.ts";

const Outcome = Schema.fromJsonString(
  Schema.Struct({
    request: Schema.String,
    outcome: Schema.String,
    answer: Schema.String,
    result: Schema.String,
    cut: Schema.optional(Schema.String),
  }),
);

const at = DateTime.makeUnsafe(Date.UTC(2026, 10, 19, 9));
const ada = TurnMember.make({ id: GitHubUserId.make(7), login: OperatorLogin.make("ada") });
const factory = ProjectScope.make({ project: ProjectId.make("factory") });
const conversation = Conversation.make({
  id: ConversationId.make("c1"),
  title: ConversationTitle.make("Read the logs"),
  scope: factory,
  anchor: Option.none(),
  createdBy: ada.login,
  createdAt: at,
});

const ran = (id: string, result: string) => {
  const call = OperationCall.make({
    operation: OperationName.make("retry"),
    summary: "Retry a failed run",
    arguments: { runId: id },
    target: CallTarget.make(`run ${id}`),
    scope: factory,
    permission: "operate",
  });
  const waiting = requested({
    id: PermissionRequestId.make(id),
    conversation: conversation.id,
    audience: factory,
    turn: TurnId.make("t1"),
    toolCall: Option.none(),
    call,
    requestedAt: at,
  });
  return settle(allow(waiting, AllowedOnce.make({ by: ada, at })), at, {
    _tag: "Succeeded",
    result,
  });
};

describe("turnPrompt", () => {
  it.effect("cuts the longest results to fit the context and keeps every request's outcome", () =>
    Effect.gen(function* () {
      const prompt = yield* turnPrompt({
        member: ada,
        grants: [],
        at,
        conversation,
        repositories: [],
        needsYou: [],
        needsTotal: 0,
        reply: defaultFormat,
        input: {
          _tag: "Outcomes",
          requests: [ran("r1", "x".repeat(100_000)), ran("r2", '{"ok":true}')],
        },
      });
      const lines = prompt
        .split("\n")
        .filter((line) => line.startsWith('- {"request":'))
        .map((line) => line.slice(2));
      assert.isAtMost(
        lines.reduce((total, line) => total + line.length, 0),
        OUTCOMES_LIMIT,
      );
      const outcomes = yield* Effect.forEach(lines, (line) => Schema.decodeEffect(Outcome)(line));
      assert.deepStrictEqual(
        outcomes.map(({ request, outcome, answer }) => [request, outcome, answer]),
        [
          ["r1", "ran", "allowed once"],
          ["r2", "ran", "allowed once"],
        ],
      );
      const [cut, whole] = outcomes;
      assert.isBelow(cut?.result.length ?? 0, 100_000);
      assert.include(cut?.cut, "of 100000 characters");
      assert.deepStrictEqual([whole?.result, whole?.cut], ['{"ok":true}', undefined]);
    }),
  );

  it.effect("gives the reference forms that usine links, and source lines only with source", () =>
    Effect.gen(function* () {
      const prompt = (repositories: ReadonlyArray<RepositoryName>) =>
        turnPrompt({
          member: ada,
          grants: [],
          at,
          conversation,
          repositories,
          needsYou: [],
          needsTotal: 0,
          reply: defaultFormat,
          input: { _tag: "Message", text: "Where does the store open?" },
        });
      const mounted = yield* prompt([RepositoryName.make("basaltbytes/usine")]);
      assert.include(mounted, "a task as #<number> in the project or <owner>/<name>#<number>");
      assert.include(mounted, "a run as its ID, and a loop, agent, worker, or label as its name");
      assert.include(mounted, "Write a source line as <owner>/<name>/<path>:<line>");
      assert.include(mounted, "/projects/<project>/runs/<run> for a run");
      const bare = yield* prompt([]);
      assert.notInclude(bare, "Write a source line");
    }),
  );

  it.effect("gives an instance turn only the references that resolve without a project", () =>
    Effect.gen(function* () {
      const prompt = yield* turnPrompt({
        member: ada,
        grants: [],
        at,
        conversation: Conversation.make({ ...conversation, scope: InstanceScope.make() }),
        repositories: [],
        needsYou: [],
        needsTotal: 0,
        reply: defaultFormat,
        input: { _tag: "Message", text: "What failed overnight?" },
      });
      assert.include(
        prompt,
        "a task as <owner>/<name>#<number>, and a loop, agent, or worker as its name in a code span.",
      );
      assert.notInclude(prompt, "#<number> in the project");
      assert.notInclude(prompt, "a run as its ID");
      assert.notInclude(prompt, "or label");
    }),
  );
});

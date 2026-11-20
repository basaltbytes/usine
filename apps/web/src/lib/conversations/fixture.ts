import { GitHubUserId, ProjectScope } from "@usine/core/access";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import {
  type AgentSessionEvent,
  RoleName,
  RoleSession,
  SessionTokensUpdated,
  TextOutput,
  TokenCount,
  ToolFinished,
  ToolStarted,
} from "@usine/core/agent/session";
import {
  Canceled,
  Conversation,
  ConversationId,
  ConversationTitle,
  defaultFormat,
  EventSequence,
  Failed,
  Interrupted,
  MemberMessage,
  MessageBody,
  MessageSequence,
  Queued,
  Running,
  Succeeded,
  SupervisorMessage,
  TurnEvent,
  TurnId,
  TurnMember,
  type TurnSource,
  type TurnState,
} from "@usine/core/conversation";
import { OperatorLogin } from "@usine/core/operator";
import { ProjectId } from "@usine/core/project";
import {
  ConversationEventsView,
  ConversationStatusView,
  ConversationsView,
  ReadMarkerView,
  ConversationView,
  EVENTS_PAGE,
  TurnView,
} from "@usine/orchestrator/operator/http";
import { AgentSessionId, HarnessSession } from "@usine/core/agent/session";
import { DateTime, Option, Schema } from "effect";

/** The project of `taskOverview`, whose repository is `basaltbytes/usine`. */
export const conversationProject = ProjectScope.make({
  project: ProjectId.make("basaltbytes-usine"),
});
export const ada = TurnMember.make({ id: GitHubUserId.make(7), login: OperatorLogin.make("ada") });
export const grace = TurnMember.make({
  id: GitHubUserId.make(8),
  login: OperatorLogin.make("grace"),
});
export const conversationId = ConversationId.make("c-1");

const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 10, 17, 9, minute));
const session = RoleSession.make({
  id: AgentSessionId.make("c-1"),
  role: RoleName.make("supervisor"),
  agent: AgentName.make("supervisor"),
  brain: BrainSpec.make({
    harness: Harness.make("claude"),
    model: ModelId.make("claude-sonnet-5-5"),
    effort: "low",
  }),
});

type Post = {
  readonly turn: string;
  readonly member: TurnMember;
  readonly text: string;
  readonly minute: number;
  readonly state: TurnState;
  readonly answer?: string;
  /** The source that the answer read. */
  readonly sources?: ReadonlyArray<TurnSource>;
};

/** Returns a conversation view with one turn per post, answered when the post has an answer. */
export const conversationOf = (
  posts: ReadonlyArray<Post>,
  title = "Why is run 7431 waiting?",
): typeof ConversationView.Type => {
  let sequence = 0;
  const messages: Array<MemberMessage | SupervisorMessage> = [];
  const turns = posts.map((post) => {
    sequence += 1;
    const id = TurnId.make(post.turn);
    const message = MessageSequence.make(sequence);
    messages.push(
      MemberMessage.make({
        conversation: conversationId,
        sequence: message,
        turn: id,
        format: defaultFormat,
        body: MessageBody.make(post.text),
        createdAt: at(post.minute),
        role: "member",
        author: post.member.login,
      }),
    );
    return {
      id,
      conversation: conversationId,
      member: post.member,
      message,
      reply: defaultFormat,
      queuedAt: at(post.minute),
      state: post.state,
      answer: post.answer,
      sources: post.sources ?? [],
      minute: post.minute,
    };
  });
  for (const turn of turns)
    if (turn.answer !== undefined) {
      sequence += 1;
      messages.push(
        SupervisorMessage.make({
          conversation: conversationId,
          sequence: MessageSequence.make(sequence),
          turn: turn.id,
          format: defaultFormat,
          body: MessageBody.make(turn.answer),
          createdAt: at(turn.minute + 1),
          role: "supervisor",
          sources: turn.sources,
        }),
      );
    }
  return {
    conversation: Conversation.make({
      id: conversationId,
      title: ConversationTitle.make(title),
      scope: conversationProject,
      anchor: Option.none(),
      createdBy: posts[0]?.member.login ?? ada.login,
      createdAt: at(posts[0]?.minute ?? 0),
    }),
    messages,
    turns: turns.map(({ answer: _answer, sources: _sources, minute: _minute, ...turn }) => turn),
    requests: [],
  };
};

export const running = (minute: number) => Running.make({ startedAt: at(minute) });
export const queued = Queued.make({});
export const answered = (minute: number) =>
  Succeeded.make({
    startedAt: at(minute),
    endedAt: at(minute + 1),
    session: HarnessSession.make({ cwd: "/conversation" }),
    usage: Option.none(),
  });
export const interrupted = (minute: number) =>
  Failed.make({
    startedAt: at(minute),
    endedAt: at(minute + 1),
    failure: Interrupted.make({}),
    usage: Option.none(),
  });
const canceledBy = (minute: number, by: TurnMember) =>
  Canceled.make({
    startedAt: Option.some(at(minute)),
    endedAt: at(minute + 1),
    by: by.login,
    usage: Option.none(),
  });

/** The events of one turn: some text, then a tool call that `finished` decides whether ended. */
export const turnEvents = (turn: string, first: number, finished: boolean) => {
  const id = TurnId.make(turn);
  const events = [
    TextOutput.make({ session, text: "Checking the overview for run 7431." }),
    ToolStarted.make({
      session,
      callId: "call-1",
      tool: "mcp__usine__overview",
      input: { view: "attention" },
    }),
    ...(finished
      ? [
          ToolFinished.make({
            session,
            callId: "call-1",
            tool: "mcp__usine__overview",
            output: '{"needsYou":[{"_tag":"ApprovalNeed","runId":"run-7431"}]}',
            isError: false,
          }),
          SessionTokensUpdated.make({ session, totalTokens: TokenCount.make(1200) }),
        ]
      : []),
  ];
  return events.map((event, index) =>
    TurnEvent.make({
      conversation: conversationId,
      sequence: EventSequence.make(first + index),
      turn: id,
      event,
    }),
  );
};

type Call = {
  readonly tool: string;
  readonly input: Schema.Json;
  /** Whether the call finished, failed, or is still running; `finished` by default. */
  readonly outcome?: "finished" | "failed" | "running";
};

const supervisorTools: ReadonlyArray<Call> = [
  { tool: "mcp__usine__overview", input: { view: "attention" } },
  { tool: "Read", input: { file_path: "packages/orchestrator/src/run/approval.ts" } },
  { tool: "Grep", input: { pattern: "awaitingApproval" } },
  { tool: "mcp__usine__run", input: { run: "run-7431" } },
  { tool: "Read", input: { file_path: "packages/config/src/loop.ts" } },
];

/** Returns `count` finished calls that cycle through the supervisor's usual tools. */
export const supervisorCalls = (count: number): ReadonlyArray<Call> =>
  Array.from({ length: count }, (_, index) => index).flatMap(
    (index) => supervisorTools[index % supervisorTools.length] ?? [],
  );

/**
 * The events of one turn: `steps` in order, where a string is a text and a call is started and,
 * unless it is running, finished.
 */
export const stepEvents = (turn: string, first: number, steps: ReadonlyArray<string | Call>) => {
  const id = TurnId.make(turn);
  const events = steps.flatMap((step, index): ReadonlyArray<AgentSessionEvent> => {
    if (Schema.is(Schema.String)(step)) return [TextOutput.make({ session, text: step })];
    const callId = `call-${index + 1}`;
    const started = ToolStarted.make({ session, callId, tool: step.tool, input: step.input });
    if (step.outcome === "running") return [started];
    const failed = step.outcome === "failed";
    return [
      started,
      ToolFinished.make({
        session,
        callId,
        tool: step.tool,
        output: failed ? "Run run-9999 was not found." : "{}",
        isError: failed,
      }),
    ];
  });
  return events.map((event, index) =>
    TurnEvent.make({
      conversation: conversationId,
      sequence: EventSequence.make(first + index),
      turn: id,
      event,
    }),
  );
};

export const markdownAnswer = [
  "Run 7431 is **waiting for approval**. The `start-dev` loop is gated:",
  "",
  "1. Open the run from **Needs attention**.",
  "2. Approve it, or cancel it if the issue is stale.",
].join("\n");

/**
 * An answer that names tasks, runs, a source line, configuration, and labels of `summaryOverview`'s
 * project in a heading, paragraphs, a list, and a table with a pull request and an issue column.
 */
export const referenceAnswer = [
  "### Where #40 stands",
  "",
  "#40 waits on review: `run-again` is running, and `run-approve` waits for approval. Its pull request carries `ready-for-review`.",
  "",
  "#1337 (React Compiler, issue #1321) passed its last two reviews and merged this morning.",
  "",
  "- #12 waits in the backlog with no run.",
  "- #1342 runs again after its first review asked for a test of the shutdown order.",
  "- #1338 was already fixed in #1321, so the failed run can be closed.",
  "- The reader keeps its place in `basaltbytes/usine/apps/web/src/components/runs/transcript/reader-line.tsx:48`.",
  "- `review-pr` runs with the `developer` agent on `eu-1`.",
  "",
  "| PR | Issue | Run | Label | Reviews | Result |",
  "| --- | --- | --- | --- | --- | --- |",
  "| #42 | #40 | `run-again` | `ready-for-review` | 1 | Waits on review |",
  "| #1359 | #1342 | None | `bug` | 1 | Fixing the review |",
  "| #1337 | #1321 | None | None | 2 | Merged |",
  "| #1352 | #1327 | None | None | 2 | Merged |",
  "",
  "Open [the task list](/projects/basaltbytes-usine/tasks) for the rest.",
].join("\n");

/** Returns a JSON response with `value` encoded by `schema`. */
export const encodedResponse = <T, E>(schema: Schema.Codec<T, E>, value: T, status = 200) =>
  new Response(JSON.stringify(Schema.encodeSync(schema)(value)), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Returns an operator API error envelope. */
export const errorResponse = (error: string, message: string, status: number) =>
  encodedResponse(
    Schema.Struct({ error: Schema.String, message: Schema.String }),
    { error, message },
    status,
  );

/** What the fake server answers; tests change it between steps. */
export interface ConversationServer {
  status: typeof ConversationStatusView.Type;
  conversations: Map<string, typeof ConversationView.Type>;
  events: Map<string, ReadonlyArray<TurnEvent>>;
  /** Answers a post; the default queues it as the server does. */
  post: (conversation: string, body: Schema.Json | undefined) => Promise<Response>;
  /** The read marker of `ada`, the signed-in member, per conversation. */
  readonly reads: Map<string, number>;
  readonly requests: Array<string>;
}

/** The list row of `record` for `ada`, as the server computes it. */
const summaryOf = (
  record: typeof ConversationView.Type,
  through: number | undefined,
): (typeof ConversationsView.Type)["conversations"][number] => {
  const last = record.messages.at(-1);
  const body = last?.body;
  const times = [
    record.conversation.createdAt,
    ...record.messages.map(({ createdAt }) => createdAt),
  ];
  return {
    conversation: record.conversation,
    lastTurn: record.turns.at(-1) ?? null,
    lastMessage: last?.sequence ?? MessageSequence.make(1),
    lastActivity: times.reduce((latest, time) => DateTime.max(latest, time)),
    preview: Schema.is(Schema.String)(body)
      ? body
          .replaceAll(/[*_`#]+/gu, "")
          .replaceAll(/\s+/gu, " ")
          .trim()
      : "",
    unread:
      record.messages.some(
        (message) =>
          message.sequence > (through ?? 0) &&
          !(message.role === "member" && message.author === ada.login),
      ) ||
      (through === undefined && record.turns.some(({ state }) => state._tag === "Failed")),
  };
};

const readyStatus: typeof ConversationStatusView.Type = { state: "ready", reason: null };

/** Returns a fake operator API for the conversation group, with `fallback` for other paths. */
export const conversationServer = (
  fallback: (url: URL, init: RequestInit | undefined) => Promise<Response>,
) => {
  const server: ConversationServer = {
    status: readyStatus,
    conversations: new Map(),
    events: new Map(),
    post: () => Promise.resolve(errorResponse("ConversationNotFound", "Not found", 404)),
    reads: new Map(),
    requests: [],
  };
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      globalThis.location.href,
    );
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (!url.pathname.startsWith("/api/conversations")) return fallback(url, init);
    server.requests.push(`${method} ${url.pathname}${url.search}`);
    if (url.pathname === "/api/conversations/status")
      return encodedResponse(ConversationStatusView, server.status);
    if (url.pathname === "/api/conversations")
      return encodedResponse(ConversationsView, {
        conversations: [...server.conversations.values()]
          .map((record) => summaryOf(record, server.reads.get(record.conversation.id)))
          .sort(
            (left, right) =>
              DateTime.toEpochMillis(right.lastActivity) -
              DateTime.toEpochMillis(left.lastActivity),
          ),
      });
    const [, , , id, part] = url.pathname.split("/");
    const record = id === undefined ? undefined : server.conversations.get(id);
    if (id === undefined || record === undefined)
      return errorResponse("ConversationNotFound", `Conversation ${id} was not found.`, 404);
    if (part === "events") {
      const after = Number(url.searchParams.get("after") ?? "0");
      const events = (server.events.get(id) ?? []).filter(({ sequence }) => sequence > after);
      const page = events.slice(0, EVENTS_PAGE);
      return encodedResponse(ConversationEventsView, {
        events: page,
        next: page.at(-1)?.sequence ?? (after === 0 ? 0 : EventSequence.make(after)),
      });
    }
    if (part === "read" && method === "POST") {
      const { through } = await new Response(init?.body).json();
      const last = record.messages.at(-1)?.sequence ?? 1;
      const marked = Math.max(server.reads.get(id) ?? 0, Math.min(Number(through), last));
      server.reads.set(id, marked);
      return encodedResponse(ReadMarkerView, {
        conversation: record.conversation.id,
        through: MessageSequence.make(marked),
        readAt: DateTime.nowUnsafe(),
      });
    }
    if (part === "messages" && method === "POST")
      return server.post(
        id,
        init?.body === undefined || init.body === null
          ? undefined
          : await new Response(init.body).json(),
      );
    if (part === "turns" && method === "POST") {
      const turn = url.pathname.split("/")[5];
      const canceled = {
        ...record,
        turns: record.turns.map((entry) =>
          entry.id === turn ? { ...entry, state: canceledBy(2, ada) } : entry,
        ),
      };
      server.conversations.set(id, canceled);
      const updated = canceled.turns.find((entry) => entry.id === turn);
      return encodedResponse(Schema.UndefinedOr(TurnView), updated);
    }
    return encodedResponse(ConversationView, record);
  };
  return { server, fetch };
};

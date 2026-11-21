import { InstanceScope, ProjectScope } from "@usine/core/access";
import { HarnessSession, HarnessSessionId } from "@usine/core/agent/session";
import {
  defaultFormat,
  followUpOf,
  MessageBody,
  MessageSequence,
  OutcomesMessage,
  Succeeded,
  SupervisorMessage,
  TurnId,
} from "@usine/core/conversation";
import {
  AllowedAlways,
  AllowedOnce,
  CallTarget,
  CoveredByGrant,
  GrantRevocation,
  isGrantable,
  OperationName,
  PermissionRequestId,
  RequestDenied,
  RequestFailed,
  RequestRan,
  type RequestState,
  RequestWaiting,
  StandingGrantId,
  type WritePermission,
} from "@usine/core/permission-request";
import type { ProjectId } from "@usine/core/project";
import {
  PermissionRequestView,
  StandingGrantsView,
  StandingGrantView,
  SupervisorActionsView,
} from "@usine/orchestrator/operator/http";
import { DateTime, Option, Schema } from "effect";
import {
  ada,
  conversationId,
  conversationProject,
  type ConversationServer,
  encodedResponse,
  errorResponse,
  grace,
} from "~/lib/conversations/fixture";
import type { Conversation, PermissionRequest } from "~/lib/conversations/timeline";

const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 10, 19, 9, minute));

type RequestFields = {
  readonly id: string;
  readonly turn: string;
  readonly toolCall: string | null;
  readonly operation: string;
  readonly summary: string;
  readonly arguments: PermissionRequest["arguments"];
  readonly target: string;
  /** The call's project, or null for an operation outside a project. */
  readonly project?: ProjectId | null;
  readonly permission?: WritePermission;
  readonly state?: RequestState;
  readonly answerable?: boolean;
};

/** Returns a permission request of the fixture conversation, waiting and answerable by default. */
const requestOf = (fields: RequestFields): PermissionRequest => {
  const project = fields.project === undefined ? conversationProject.project : fields.project;
  const operation = OperationName.make(fields.operation);
  const permission = fields.permission ?? (project === null ? "admin" : "operate");
  const scope = project === null ? InstanceScope.make() : ProjectScope.make({ project });
  return {
    id: PermissionRequestId.make(fields.id),
    conversation: conversationId,
    turn: TurnId.make(fields.turn),
    toolCall: fields.toolCall,
    operation,
    summary: fields.summary,
    arguments: fields.arguments,
    target: CallTarget.make(fields.target),
    project,
    permission,
    grantable: isGrantable({ operation, permission, scope }),
    requestedAt: at(2),
    state: fields.state ?? RequestWaiting.make({}),
    reportedIn: null,
    answerable: fields.answerable ?? true,
  };
};

/** A request to retry run 7431, made by the tool call `call-2` of turn `t-1`. */
export const retryRequest = (overrides: Partial<RequestFields> = {}) =>
  requestOf({
    id: "r-1",
    turn: "t-1",
    toolCall: "call-2",
    operation: "retry",
    summary: "Retry a failed run",
    arguments: { runId: "run-7431" },
    target: "run run-7431",
    ...overrides,
  });

/** A request to change the implement loop of the fixture project, which needs maintain. */
export const loopChangeRequest = (overrides: Partial<RequestFields> = {}) =>
  requestOf({
    id: "r-2",
    turn: "t-1",
    toolCall: "call-3",
    operation: "replaceConfigurationEntity",
    summary: "Replace a configuration entity",
    arguments: {
      kind: "loop",
      identifier: `${conversationProject.project}/implement`,
      body: {
        expected: 12,
        text: "---\ntrigger: { on: issue, if: 'true' }\nagent: developer\ntimeout: 45m\n---\nImplement the issue, then run the tests.\n",
      },
    },
    target: `loop ${conversationProject.project}/implement`,
    permission: "maintain",
    ...overrides,
  });

/** A request to send an operator message to run 7431's agent, which no grant can cover. */
export const messageRequest = (overrides: Partial<RequestFields> = {}) =>
  requestOf({
    id: "r-2",
    turn: "t-1",
    toolCall: "call-3",
    operation: "intervene",
    summary: "Send an operator message",
    arguments: {
      runId: "run-7431",
      body: { message: "Rerun only sessions.test.ts and report the timeout." },
    },
    target: "run run-7431",
    ...overrides,
  });

export const ranOnce = (minute: number) =>
  RequestRan.make({
    allowance: AllowedOnce.make({ by: ada, at: at(minute) }),
    endedAt: at(minute),
    result: '{"ok":true}',
  });
const ranAlways = (minute: number) =>
  RequestRan.make({
    allowance: AllowedAlways.make({
      by: ada,
      at: at(minute),
      grant: StandingGrantId.make("r-1:grant"),
    }),
    endedAt: at(minute),
    result: '{"ok":true}',
  });
export const deniedBy = (minute: number) => RequestDenied.make({ by: grace, at: at(minute) });
/** A call that ada's standing grant covered, refused because the run was running. */
export const failedUnderGrant = (minute: number) =>
  RequestFailed.make({
    allowance: CoveredByGrant.make({
      by: ada,
      at: at(minute),
      grant: StandingGrantId.make("r-1:grant"),
    }),
    endedAt: at(minute),
    error: "HTTP 409\nCannot retry run run-7502 while it is running.",
  });

type Grant = typeof StandingGrantView.Type;

/** A standing grant of retries in the fixture project, allowed by ada. */
export const retryGrant = (overrides: Partial<Grant> = {}): Grant => ({
  id: StandingGrantId.make("r-1:grant"),
  operation: OperationName.make("retry"),
  summary: "Retry a failed run",
  project: conversationProject.project,
  member: ada,
  request: PermissionRequestId.make("r-1"),
  createdAt: at(3),
  lastUsedAt: at(40),
  revoked: null,
  applies: true,
  revocable: true,
  ...overrides,
});

/**
 * Returns `record` with the turn that reports the outcomes of turn `turn`: the outcomes message
 * with `outcomes` as its Markdown, and `reply` as that turn's answer.
 */
export const withFollowUp = (
  record: Conversation,
  turn: string,
  outcomes: string,
  reply: string,
): Conversation => {
  const last = Math.max(0, ...record.messages.map(({ sequence }) => sequence));
  const id = followUpOf(TurnId.make(turn));
  return {
    ...record,
    messages: [
      ...record.messages,
      OutcomesMessage.make({
        conversation: record.conversation.id,
        sequence: MessageSequence.make(last + 1),
        turn: id,
        format: defaultFormat,
        body: MessageBody.make(outcomes),
        createdAt: at(5),
        role: "usine",
        reports: TurnId.make(turn),
      }),
      SupervisorMessage.make({
        conversation: record.conversation.id,
        sequence: MessageSequence.make(last + 2),
        turn: id,
        format: defaultFormat,
        body: MessageBody.make(reply),
        createdAt: at(6),
        role: "supervisor",
      }),
    ],
    turns: [
      ...record.turns,
      {
        id,
        conversation: record.conversation.id,
        member: ada,
        message: MessageSequence.make(last + 1),
        reply: defaultFormat,
        queuedAt: at(5),
        state: Succeeded.make({
          startedAt: at(5),
          endedAt: at(6),
          session: HarnessSession.make({
            id: HarnessSessionId.make("saved-conversation"),
            cwd: "/conversation",
          }),
          usage: Option.none(),
        }),
      },
    ],
  };
};

/** What the fake server answers for supervisor permissions; tests change it between steps. */
export interface PermissionServer {
  readonly grants: Array<Grant>;
  readonly actions: Array<PermissionRequest>;
  /** The answers posted, as `request answer`. */
  readonly answers: Array<string>;
}

const Answer = Schema.Struct({ answer: Schema.Literals(["once", "always", "deny"]) });

/**
 * Serves permission answers, standing grants, and allowed calls next to `conversations`, and
 * passes every other request to `next`. An answer runs the call at once.
 */
export const permissionServer = (
  conversations: ConversationServer,
  next: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) => {
  const server: PermissionServer = { grants: [], actions: [], answers: [] };
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      globalThis.location.href,
    );
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.pathname === "/api/supervisor/grants")
      return encodedResponse(StandingGrantsView, { grants: server.grants });
    if (url.pathname === "/api/supervisor/actions")
      return encodedResponse(SupervisorActionsView, { actions: server.actions });
    if (url.pathname.startsWith("/api/supervisor/grants/") && method === "DELETE") {
      const id = decodeURIComponent(url.pathname.split("/")[4] ?? "");
      const grant = server.grants.find((entry) => entry.id === id);
      if (grant === undefined)
        return errorResponse("GrantNotFound", `Standing grant ${id} was not found.`, 404);
      server.grants.splice(server.grants.indexOf(grant), 1);
      return encodedResponse(StandingGrantView, {
        ...grant,
        revoked: GrantRevocation.make({ by: ada.login, at: at(50) }),
        applies: false,
      });
    }
    const [, , , id, part, request, action] = url.pathname.split("/");
    if (part === "requests" && action === "answer" && method === "POST" && id !== undefined) {
      const record = conversations.conversations.get(id);
      const current = record?.requests.find((entry) => entry.id === request);
      if (record === undefined || current === undefined)
        return errorResponse("PermissionRequestNotFound", "Not found", 404);
      const { answer } = Schema.decodeUnknownSync(Answer)(await new Response(init?.body).json());
      server.answers.push(`${current.id} ${answer}`);
      const answered: PermissionRequest = {
        ...current,
        answerable: false,
        state: answer === "deny" ? deniedBy(5) : answer === "always" ? ranAlways(5) : ranOnce(5),
      };
      conversations.conversations.set(id, {
        ...record,
        requests: record.requests.map((entry) => (entry.id === current.id ? answered : entry)),
      });
      return encodedResponse(PermissionRequestView, answered);
    }
    return next(input, init);
  };
  return { server, fetch };
};

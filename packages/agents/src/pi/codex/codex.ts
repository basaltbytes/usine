import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  ChildSession,
  PoolRateLimitsUpdated,
  RateLimitsSnapshot,
  RateLimitWindow as CoreRateLimitWindow,
  SessionStarted,
  SessionTokensUpdated,
  TextOutput,
  ToolFinished,
  ToolStarted,
} from "@usine/core/agent/session";
import { DateTime, Deferred, Effect, Layer, Option, Schema, Stream } from "effect";
import { AccountUpdated } from "../../protocol/codex.ts";
import type {
  ModelListParams,
  ThreadStartParams,
  TurnInterruptParams,
  TurnStartParams,
  TurnSteerParams,
} from "../../protocol/codex.ts";
import {
  AgentResultError,
  type AgentSessionError,
  CodexChildBackend,
  type RunningSession,
  SessionOperationError,
  UnknownModelError,
  UnsupportedEffortError,
} from "../../runtime.ts";
import { sessionChannel } from "../session.ts";
import { sessionConversation } from "../conversation.ts";
import { CodexTokenUsage } from "../usage.ts";
import { CodexAppServer, type CodexClient, operationError } from "./app-server.ts";
import { codexPoolUnavailable, initializeCodex, verifyCodexAccount } from "./account.ts";

export { CodexAppServer, codexAppServerLive, type CodexConnection } from "./app-server.ts";

type CodexRequestPayload =
  | ModelListParams
  | ThreadStartParams
  | TurnStartParams
  | TurnSteerParams
  | TurnInterruptParams;

const json = (value: CodexRequestPayload): Schema.Json =>
  Schema.decodeUnknownSync(Schema.Json)(JSON.parse(JSON.stringify(value)));

const ModelListResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      model: Schema.String,
      supportedReasoningEfforts: Schema.optionalKey(
        Schema.Array(Schema.Struct({ reasoningEffort: Schema.String })),
      ),
    }),
  ),
  nextCursor: Schema.NullOr(Schema.String),
});
const ThreadStartResponse = Schema.Struct({
  thread: Schema.Struct({ id: Schema.NonEmptyString }),
  model: Schema.NonEmptyString,
  instructionSources: Schema.Array(Schema.String),
});
const TurnStartResponse = Schema.Struct({
  turn: Schema.Struct({ id: Schema.NonEmptyString }),
});
const ItemNotification = Schema.Struct({
  item: Schema.Json,
  threadId: Schema.String,
  turnId: Schema.String,
});
const AgentMessageItem = Schema.Struct({
  type: Schema.Literal("agentMessage"),
  id: Schema.NonEmptyString,
  text: Schema.String,
  phase: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const ToolItem = Schema.Struct({
  type: Schema.Literals([
    "commandExecution",
    "fileChange",
    "mcpToolCall",
    "dynamicToolCall",
    "webSearch",
    "imageView",
    "imageGeneration",
  ] as const),
  id: Schema.NonEmptyString,
  status: Schema.optionalKey(Schema.String),
  success: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
});
const TurnCompleted = Schema.Struct({
  turn: Schema.Struct({
    id: Schema.String,
    status: Schema.Literals(["completed", "interrupted", "failed", "inProgress"] as const),
    error: Schema.NullOr(
      Schema.Struct({
        message: Schema.String,
        additionalDetails: Schema.NullOr(Schema.String),
      }),
    ),
  }),
});
// Upstream sends this notification as a sparse rolling update: any account
// field may be absent, so only the load figure is required.
const RateLimitWindow = Schema.Struct({
  usedPercent: Schema.Number,
  windowDurationMins: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  resetsAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
const RateLimitsUpdated = Schema.Struct({
  rateLimits: Schema.Struct({
    limitId: Schema.optionalKey(Schema.NullOr(Schema.String)),
    limitName: Schema.optionalKey(Schema.NullOr(Schema.String)),
    primary: Schema.optionalKey(Schema.NullOr(RateLimitWindow)),
    secondary: Schema.optionalKey(Schema.NullOr(RateLimitWindow)),
  }),
});

const decodeResponse = <S extends Schema.Top>(
  schema: S,
  operation: SessionOperationError["operation"],
  client: CodexClient,
  label: string,
  value: Schema.Json,
): Effect.Effect<S["Type"], SessionOperationError, S["DecodingServices"]> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((cause) =>
      operationError(operation, client, `Codex returned an invalid ${label}`, cause),
    ),
  );

/** Decodes one notification payload; an undecodable payload is logged and skipped, never fatal. */
const decodeNotification = <S extends Schema.Top>(
  schema: S,
  label: string,
  sessionId: AgentSessionId,
  value: Schema.Json,
): Effect.Effect<Option.Option<S["Type"]>, never, S["DecodingServices"]> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.map(Option.some),
    Effect.catch((cause) =>
      Effect.logWarning(`Skipping an undecodable Codex ${label}`, { cause, sessionId }).pipe(
        Effect.as(Option.none()),
      ),
    ),
  );

const toolName = (item: typeof ToolItem.Type): string => {
  switch (item.type) {
    case "commandExecution":
      return "command";
    case "fileChange":
      return "file_change";
    case "mcpToolCall":
      return "mcp_tool";
    case "dynamicToolCall":
      return "dynamic_tool";
    case "webSearch":
      return "web_search";
    case "imageView":
      return "image_view";
    case "imageGeneration":
      return "image_generation";
  }
};

const rateLimitWindow = (window: typeof RateLimitWindow.Type): CoreRateLimitWindow =>
  new CoreRateLimitWindow({
    usedPercent: window.usedPercent,
    windowDurationMinutes: Option.fromNullishOr(window.windowDurationMins),
    resetsAt: Option.fromNullishOr(window.resetsAt).pipe(Option.map(DateTime.fromEpochSeconds)),
  });

/** Server pushes with no session event shape; they still reach the operator's logs. */
const DIAGNOSTIC_METHODS: ReadonlySet<string> = new Set([
  "error",
  "warning",
  "configWarning",
  "deprecationNotice",
  "guardianWarning",
  "model/rerouted",
]);

const makeCodexChild = Effect.gen(function* () {
  const appServer = yield* CodexAppServer;

  const launch: CodexChildBackend["Service"]["launch"] = Effect.fn("CodexChildBackend.launch")(
    function* (request) {
      yield* Effect.annotateCurrentSpan({
        agent: request.session.agent,
        effort: request.session.brain.effort,
        harness: request.session.brain.harness,
        model: request.session.brain.model,
        parentSessionId: request.session.parentId,
        sessionId: request.session.id,
      });
      yield* Effect.logInfo("Launching Codex child session");
      const client: CodexClient = { cwd: request.cwd, sessionId: Option.some(request.session.id) };
      const connection = yield* appServer.open(client);
      yield* initializeCodex(connection);
      const pool = yield* verifyCodexAccount(connection, request.session.brain.model);

      const models: Array<(typeof ModelListResponse.Type.data)[number]> = [];
      let cursor: string | null = null;
      do {
        const params: ModelListParams = { cursor, includeHidden: true, limit: 100 };
        const response = yield* connection.request("launch", "model/list", json(params));
        const page = yield* decodeResponse(
          ModelListResponse,
          "launch",
          client,
          "model list",
          response,
        );
        models.push(...page.data);
        cursor = page.nextCursor;
      } while (cursor !== null);
      const requestedModel = request.session.brain.model;
      const catalogModel = models.find(
        (model) => model.id === requestedModel || model.model === requestedModel,
      );
      if (catalogModel === undefined) {
        yield* Effect.logError("Codex child rejected an unknown model", { model: requestedModel });
        return yield* new UnknownModelError({
          harness: "codex",
          model: requestedModel,
          message: `Codex does not expose model ${requestedModel}`,
        });
      }
      const effort = request.session.brain.effort === "off" ? "none" : request.session.brain.effort;
      const supportedEfforts = catalogModel.supportedReasoningEfforts;
      if (
        supportedEfforts !== undefined &&
        supportedEfforts.length > 0 &&
        !supportedEfforts.some((option) => option.reasoningEffort === effort)
      ) {
        yield* Effect.logError("Codex child rejected an unsupported effort", {
          effort: request.session.brain.effort,
          model: requestedModel,
          supported: supportedEfforts.map((option) => option.reasoningEffort),
        });
        return yield* new UnsupportedEffortError({
          harness: "codex",
          model: requestedModel,
          effort: request.session.brain.effort,
          message: `Codex model ${requestedModel} does not support effort ${effort}`,
        });
      }

      const threadParams: ThreadStartParams = {
        model: requestedModel,
        allowProviderModelFallback: false,
        cwd: request.cwd,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        ephemeral: true,
        serviceName: "usine",
      };
      const threadJson = yield* connection.request("launch", "thread/start", json(threadParams));
      const thread = yield* decodeResponse(
        ThreadStartResponse,
        "launch",
        client,
        "thread start response",
        threadJson,
      );
      yield* Effect.logDebug("Codex child started a thread", {
        instructionSources: thread.instructionSources.length,
        model: thread.model,
        sessionId: request.session.id,
      });
      const session = new ChildSession({
        id: request.session.id,
        parentId: request.session.parentId,
        agent: request.session.agent,
        brain: new BrainSpec({
          harness: "codex",
          model: ModelId.make(thread.model),
          effort: request.session.brain.effort,
        }),
      });
      const channel = yield* sessionChannel({
        label: "Codex child session",
        sessionId: session.id,
      });
      yield* channel.emit(new SessionStarted({ session }));
      const turnParams: TurnStartParams = {
        threadId: thread.thread.id,
        input: [{ type: "text", text: request.prompt, text_elements: [] }],
        cwd: request.cwd,
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
        effort,
      };
      let turnId = "";
      let turnActive = false;
      let interrupting = false;
      const toolsInFlight = new Set<string>();
      const pendingMessages: string[] = [];
      let lastText: string | undefined;
      let finalText: string | undefined;
      const startTurn = Effect.fn("CodexChildBackend.startTurn")(function* (message: string) {
        yield* Effect.annotateCurrentSpan({ sessionId: session.id });
        const response = yield* connection.request(
          "stream",
          "turn/start",
          json({ ...turnParams, input: [{ type: "text", text: message, text_elements: [] }] }),
        );
        const started = yield* decodeResponse(
          TurnStartResponse,
          "stream",
          client,
          "turn start response",
          response,
        );
        turnId = started.turn.id;
        turnActive = true;
        lastText = undefined;
        finalText = undefined;
      });
      const interruptTurn = Effect.fn("CodexChildBackend.interruptTurn")(function* () {
        yield* Effect.annotateCurrentSpan({ sessionId: session.id });
        if (!turnActive || interrupting) return;
        interrupting = true;
        yield* connection.request(
          "interrupt",
          "turn/interrupt",
          json({ threadId: thread.thread.id, turnId }),
        );
      });
      const steer = Effect.fn("CodexChildBackend.steer")(function* (message: string) {
        yield* Effect.annotateCurrentSpan({ sessionId: session.id });
        if (interrupting) {
          pendingMessages.push(message);
          return;
        }
        if (!turnActive) return yield* startTurn(message);
        yield* connection.request(
          "steer",
          "turn/steer",
          json({
            threadId: thread.thread.id,
            expectedTurnId: turnId,
            input: [{ type: "text", text: message, text_elements: [] }],
          }),
        );
      });
      const conversation = yield* sessionConversation({
        session,
        channel,
        send: steer,
        pause: Effect.suspend(() => (toolsInFlight.size === 0 ? interruptTurn() : Effect.void)),
        beforeFinish: connection.close,
      });
      yield* startTurn(request.prompt);

      const fail = Effect.fn("CodexChildBackend.fail")(function* (error: AgentSessionError) {
        yield* connection.close.pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("Codex child cleanup failed while reporting its original failure", {
              cause,
              sessionId: session.id,
            }),
          ),
          Effect.ignore,
        );
        yield* channel.fail(error);
      });
      const consume = connection.notifications.pipe(
        Stream.runForEach(({ method, params }) =>
          Effect.gen(function* () {
            if (method === "thread/tokenUsage/updated") {
              const usage = yield* decodeNotification(
                CodexTokenUsage,
                "token usage",
                session.id,
                params,
              );
              if (Option.isSome(usage) && usage.value.threadId === thread.thread.id) {
                yield* channel.emit(
                  new SessionTokensUpdated({
                    session,
                    totalTokens: usage.value.tokenUsage.total.totalTokens,
                  }),
                );
              }
              return;
            }
            if (method === "item/started") {
              const notification = yield* decodeNotification(
                ItemNotification,
                "item notification",
                session.id,
                params,
              );
              if (Option.isNone(notification)) return;
              if (notification.value.turnId !== turnId) {
                return yield* Effect.logDebug("Skipping a Codex item from another turn", {
                  sessionId: session.id,
                  turnId: notification.value.turnId,
                });
              }
              if (!Schema.is(ToolItem)(notification.value.item)) return;
              toolsInFlight.add(notification.value.item.id);
              return yield* channel.emit(
                new ToolStarted({
                  session,
                  callId: notification.value.item.id,
                  tool: toolName(notification.value.item),
                  input: notification.value.item,
                }),
              );
            }
            if (method === "item/completed") {
              const notification = yield* decodeNotification(
                ItemNotification,
                "item notification",
                session.id,
                params,
              );
              if (Option.isNone(notification)) return;
              if (notification.value.turnId !== turnId) {
                return yield* Effect.logDebug("Skipping a Codex item from another turn", {
                  sessionId: session.id,
                  turnId: notification.value.turnId,
                });
              }
              const item = notification.value.item;
              if (Schema.is(AgentMessageItem)(item)) {
                const text = item.text.trim();
                if (text.length === 0) return;
                lastText = text;
                if (item.phase === "final_answer") finalText = text;
                return yield* channel.emit(new TextOutput({ session, text }));
              }
              if (!Schema.is(ToolItem)(item)) return;
              toolsInFlight.delete(item.id);
              yield* channel.emit(
                new ToolFinished({
                  session,
                  callId: item.id,
                  tool: toolName(item),
                  output: item,
                  isError:
                    item.status === "failed" ||
                    item.status === "declined" ||
                    item.success === false,
                }),
              );
              if (toolsInFlight.size === 0 && (yield* conversation.isPaused))
                yield* interruptTurn();
              return;
            }
            if (method === "account/updated") {
              const account = yield* Schema.decodeUnknownEffect(AccountUpdated)(params).pipe(
                Effect.mapError(() => codexPoolUnavailable(request.session.brain.model)),
              );
              if (account.authMode !== "chatgpt" && account.authMode !== "chatgptAuthTokens") {
                yield* Effect.logError("Codex authentication changed during the session", {
                  sessionId: session.id,
                  authentication: account.authMode ?? "logged-out",
                  requiredPool: pool,
                });
                return yield* codexPoolUnavailable(request.session.brain.model);
              }
              return;
            }
            if (method === "account/rateLimits/updated") {
              const notification = yield* decodeNotification(
                RateLimitsUpdated,
                "rate-limit notification",
                session.id,
                params,
              );
              if (Option.isNone(notification)) return;
              const snapshot = notification.value.rateLimits;
              return yield* channel.emit(
                new PoolRateLimitsUpdated({
                  session,
                  pool,
                  rateLimits: new RateLimitsSnapshot({
                    limitId: Option.fromNullishOr(snapshot.limitId),
                    limitName: Option.fromNullishOr(snapshot.limitName),
                    primary: Option.fromNullishOr(snapshot.primary).pipe(
                      Option.map(rateLimitWindow),
                    ),
                    secondary: Option.fromNullishOr(snapshot.secondary).pipe(
                      Option.map(rateLimitWindow),
                    ),
                  }),
                }),
              );
            }
            if (method === "turn/completed") {
              const completed = yield* decodeResponse(
                TurnCompleted,
                "stream",
                client,
                "turn completion",
                params,
              );
              if (completed.turn.id !== turnId) {
                return yield* Effect.logDebug("Skipping another turn's completion", {
                  sessionId: session.id,
                  turnId: completed.turn.id,
                });
              }
              turnActive = false;
              const wasInterrupted = interrupting;
              interrupting = false;
              toolsInFlight.clear();
              if (
                completed.turn.status === "completed" ||
                (completed.turn.status === "interrupted" &&
                  wasInterrupted &&
                  ((yield* conversation.isPaused) || pendingMessages.length > 0))
              ) {
                const nextMessage = pendingMessages.shift();
                if (nextMessage !== undefined) {
                  yield* startTurn(nextMessage);
                  for (const message of pendingMessages.splice(0)) yield* steer(message);
                  return;
                }
                return yield* conversation.finish(finalText ?? lastText ?? "Codex turn paused");
              }
              const detail =
                completed.turn.error?.message ??
                (completed.turn.status === "interrupted"
                  ? "Codex child session was interrupted"
                  : "Codex child session failed");
              return yield* fail(
                new AgentResultError({
                  sessionId: Option.some(session.id),
                  message: detail,
                }),
              );
            }
            if (DIAGNOSTIC_METHODS.has(method)) {
              return yield* Effect.logWarning("Codex reported a diagnostic", {
                method,
                params,
                sessionId: session.id,
              });
            }
            // Streaming deltas repeat content that the completed items deliver.
            if (method.toLowerCase().includes("delta")) return;
            yield* Effect.logDebug("Ignoring an unhandled Codex notification", {
              method,
              sessionId: session.id,
            });
          }),
        ),
        Effect.flatMap(() =>
          Effect.all([channel.isTerminal, conversation.isClosing]).pipe(
            Effect.flatMap(([terminal, closing]) =>
              terminal || closing
                ? Effect.void
                : channel.fail(
                    operationError(
                      "stream",
                      client,
                      "Codex notification stream closed without a result",
                      new Error("unexpected end of notifications"),
                    ),
                  ),
            ),
          ),
        ),
        Effect.catch(fail),
      );
      yield* Effect.forkScoped(consume);

      const interrupt = interruptTurn();
      return {
        session,
        events: Stream.fromQueue(channel.events),
        interrupt,
        result: Deferred.await(channel.result),
        steer,
        intervene: conversation.intervene,
      } satisfies RunningSession;
    },
  );
  return CodexChildBackend.of({ launch });
});

/** Provides Codex coding sessions for tasks delegated by a parent. */
export const codexChildBackendLayer = Layer.effect(CodexChildBackend, makeCodexChild);

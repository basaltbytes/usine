import { Agent } from "@usine/core";
import { DateTime, Deferred, Effect, Layer, Option, Schema, Stream } from "effect";
import type {
  InitializeParams,
  ModelListParams,
  ThreadStartParams,
  TurnInterruptParams,
  TurnStartParams,
  TurnSteerParams,
} from "../../protocol/codex.ts";
import {
  AgentResultError,
  CodexChildBackend,
  type ChildRequest,
  type RunningSession,
  SessionOperationError,
  UnknownModelError,
  UnsupportedEffortError,
} from "../../runtime.ts";
import { sessionChannel } from "../session.ts";
import { CodexAppServer, operationError } from "./app-server.ts";

type CodexRequestPayload =
  | InitializeParams
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
// Upstream documents this notification as a sparse rolling update: any
// account metadata may be absent, so every field except the load figure
// itself is optional here.
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
  request: ChildRequest,
  label: string,
  value: Schema.Json,
): Effect.Effect<S["Type"], SessionOperationError, S["DecodingServices"]> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((cause) =>
      operationError(operation, request, `Codex returned an invalid ${label}`, cause),
    ),
  );

/** Decodes one notification payload, logging and skipping instead of failing the session. */
const decodeNotification = <S extends Schema.Top>(
  schema: S,
  label: string,
  sessionId: Agent.SessionId,
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

const rateLimitWindow = (window: typeof RateLimitWindow.Type): Agent.RateLimitWindow =>
  new Agent.RateLimitWindow({
    usedPercent: window.usedPercent,
    windowDurationMinutes: Option.fromNullishOr(window.windowDurationMins),
    resetsAt: Option.fromNullishOr(window.resetsAt).pipe(Option.map(DateTime.fromEpochSeconds)),
  });

/** Server pushes that must reach the operator's logs even though no session event carries them. */
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
      const connection = yield* appServer.open(request);
      const initialize: InitializeParams = {
        clientInfo: { name: "usine", title: "usine", version: "0.0.1" },
        capabilities: null,
      };
      yield* connection.request("launch", "initialize", json(initialize));
      yield* connection.notify("launch", "initialized", {});

      const models: Array<(typeof ModelListResponse.Type.data)[number]> = [];
      let cursor: string | null = null;
      do {
        const params: ModelListParams = { cursor, includeHidden: true, limit: 100 };
        const response = yield* connection.request("launch", "model/list", json(params));
        const page = yield* decodeResponse(
          ModelListResponse,
          "launch",
          request,
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
        request,
        "thread start response",
        threadJson,
      );
      yield* Effect.logDebug("Codex child started a thread", {
        instructionSources: thread.instructionSources.length,
        model: thread.model,
        sessionId: request.session.id,
      });
      const session = new Agent.ChildSession({
        id: request.session.id,
        parentId: request.session.parentId,
        agent: request.session.agent,
        brain: new Agent.BrainSpec({
          harness: "codex",
          model: Agent.ModelId.make(thread.model),
          effort: request.session.brain.effort,
        }),
      });
      const channel = yield* sessionChannel({
        label: "Codex child session",
        sessionId: session.id,
      });
      yield* channel.emit(new Agent.SessionStarted({ session }));
      const turnParams: TurnStartParams = {
        threadId: thread.thread.id,
        input: [{ type: "text", text: request.prompt, text_elements: [] }],
        cwd: request.cwd,
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
        effort,
      };
      const turnJson = yield* connection.request("stream", "turn/start", json(turnParams));
      const turn = yield* decodeResponse(
        TurnStartResponse,
        "stream",
        request,
        "turn start response",
        turnJson,
      );
      let lastText: string | undefined;
      let finalText: string | undefined;

      const consume = connection.notifications.pipe(
        Stream.runForEach(({ method, params }) =>
          Effect.gen(function* () {
            if (method === "item/started") {
              const notification = yield* decodeNotification(
                ItemNotification,
                "item notification",
                session.id,
                params,
              );
              if (Option.isNone(notification)) return;
              if (notification.value.turnId !== turn.turn.id) {
                return yield* Effect.logDebug("Skipping a Codex item from another turn", {
                  sessionId: session.id,
                  turnId: notification.value.turnId,
                });
              }
              if (!Schema.is(ToolItem)(notification.value.item)) return;
              return yield* channel.emit(
                new Agent.ToolStarted({
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
              if (notification.value.turnId !== turn.turn.id) {
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
                return yield* channel.emit(new Agent.TextOutput({ session, text }));
              }
              if (!Schema.is(ToolItem)(item)) return;
              return yield* channel.emit(
                new Agent.ToolFinished({
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
                new Agent.PoolRateLimitsUpdated({
                  session,
                  // Workers provision Codex children on ChatGPT-plan login
                  // state (ADR 0005); an API-key login would misattribute
                  // these windows, and preflighting it is issue #60's scope.
                  pool: "chatgptPlan",
                  rateLimits: new Agent.RateLimitsSnapshot({
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
                request,
                "turn completion",
                params,
              );
              if (completed.turn.id !== turn.turn.id) {
                return yield* Effect.logDebug("Skipping another turn's completion", {
                  sessionId: session.id,
                  turnId: completed.turn.id,
                });
              }
              if (completed.turn.status === "completed") {
                return yield* channel.finish(
                  session,
                  finalText ?? lastText ?? "Codex child session completed",
                );
              }
              const detail =
                completed.turn.error?.message ??
                (completed.turn.status === "interrupted"
                  ? "Codex child session was interrupted"
                  : "Codex child session failed");
              return yield* channel.fail(
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
            // Streaming deltas re-deliver content the completed items carry.
            if (method.toLowerCase().includes("delta")) return;
            yield* Effect.logDebug("Ignoring an unhandled Codex notification", {
              method,
              sessionId: session.id,
            });
          }),
        ),
        Effect.flatMap(() =>
          channel.isTerminal.pipe(
            Effect.flatMap((terminal) =>
              terminal
                ? Effect.void
                : channel.fail(
                    operationError(
                      "stream",
                      request,
                      "Codex notification stream closed without a result",
                      new Error("unexpected end of notifications"),
                    ),
                  ),
            ),
          ),
        ),
        Effect.catch((error) => channel.fail(error)),
      );
      yield* Effect.forkScoped(consume);

      const steer = Effect.fn("CodexChildBackend.steer")((message: string) => {
        const params: TurnSteerParams = {
          threadId: thread.thread.id,
          expectedTurnId: turn.turn.id,
          input: [{ type: "text", text: message, text_elements: [] }],
        };
        return Effect.logDebug("Steering Codex child session", { sessionId: session.id }).pipe(
          Effect.andThen(connection.request("steer", "turn/steer", json(params))),
          Effect.asVoid,
        );
      });
      const interruptParams: TurnInterruptParams = {
        threadId: thread.thread.id,
        turnId: turn.turn.id,
      };
      const interrupt = Effect.logInfo("Interrupting Codex child session", {
        sessionId: session.id,
      }).pipe(
        Effect.andThen(connection.request("interrupt", "turn/interrupt", json(interruptParams))),
        Effect.asVoid,
      );
      return {
        session,
        events: Stream.fromQueue(channel.events),
        interrupt,
        result: Deferred.await(channel.result),
        steer,
      } satisfies RunningSession;
    },
  );
  return CodexChildBackend.of({ launch });
});

export const codexChildBackendLayer = Layer.effect(CodexChildBackend, makeCodexChild);

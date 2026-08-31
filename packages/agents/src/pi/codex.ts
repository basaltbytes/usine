import type { InitializeParams } from "@pwrdrvr/codex-app-server-protocol";
import type {
  ModelListParams,
  ThreadStartParams,
  TurnInterruptParams,
  TurnStartParams,
  TurnSteerParams,
} from "@pwrdrvr/codex-app-server-protocol/v2";
import { Agent } from "@usine/core";
import {
  Cause,
  Context,
  DateTime,
  Deferred,
  Effect,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { homedir } from "node:os";
import {
  AgentResultError,
  CodexChildBackend,
  type ChildRequest,
  type RunningSession,
  SessionOperationError,
  UnknownModelError,
} from "../runtime.ts";
import { sessionChannel } from "./session.ts";

export interface CodexNotification {
  readonly method: string;
  readonly params: Schema.Json;
}

/** One scoped JSON-RPC app-server connection, narrow enough to script in tests. */
export interface CodexConnection {
  readonly notifications: Stream.Stream<CodexNotification, SessionOperationError>;
  readonly request: (
    operation: SessionOperationError["operation"],
    method: string,
    params: Schema.Json,
  ) => Effect.Effect<Schema.Json, SessionOperationError>;
  readonly notify: (
    operation: SessionOperationError["operation"],
    method: string,
    params: Schema.Json,
  ) => Effect.Effect<void, SessionOperationError>;
}

/** Process seam for the Codex app-server transport. */
export class CodexAppServer extends Context.Service<
  CodexAppServer,
  {
    readonly open: (
      request: ChildRequest,
    ) => Effect.Effect<CodexConnection, SessionOperationError, Scope.Scope>;
  }
>()("@usine/agents/pi/CodexAppServer") {}

interface OutboundRpcRequest {
  readonly id: number;
  readonly method: string;
  readonly params: Schema.Json;
}

interface OutboundRpcNotification {
  readonly method: string;
  readonly params: Schema.Json;
}

interface OutboundRpcError {
  readonly id: number | string;
  readonly error: { readonly code: number; readonly message: string };
}

type CodexProtocolPayload =
  | InitializeParams
  | ModelListParams
  | ThreadStartParams
  | TurnStartParams
  | TurnSteerParams
  | TurnInterruptParams
  | OutboundRpcRequest
  | OutboundRpcNotification
  | OutboundRpcError;

const json = (value: CodexProtocolPayload): Schema.Json =>
  Schema.decodeUnknownSync(Schema.Json)(JSON.parse(JSON.stringify(value)));

const RpcSuccessResponse = Schema.Struct({
  id: Schema.Int,
  result: Schema.Json,
});
const RpcErrorResponse = Schema.Struct({
  id: Schema.Int,
  error: Schema.Struct({
    code: Schema.Number,
    message: Schema.String,
    data: Schema.optionalKey(Schema.Json),
  }),
});
const RpcResponse = Schema.Union([RpcSuccessResponse, RpcErrorResponse]);
const RpcMessage = Schema.Struct({
  method: Schema.String,
  params: Schema.optionalKey(Schema.Json),
  id: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])),
});
const decodeLine = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));
const encoder = new TextEncoder();

const operationError = (
  operation: SessionOperationError["operation"],
  request: ChildRequest,
  message: string,
  cause: unknown,
): SessionOperationError =>
  new SessionOperationError({
    operation,
    sessionId: Option.some(request.session.id),
    message,
    cause,
  });

interface PendingRequest {
  readonly operation: SessionOperationError["operation"];
  readonly response: Deferred.Deferred<Schema.Json, SessionOperationError>;
}

const repositoryTrustOverride = (cwd: string): string =>
  `projects.${JSON.stringify(cwd)}.trust_level="untrusted"`;

export const codexAppServerCommand = (
  cwd: string,
  stdin?: ChildProcess.CommandOptions["stdin"],
): ChildProcess.Command => {
  const options: ChildProcess.CommandOptions = {
    // Starting outside the worktree prevents process startup from
    // discovering repository-owned config before thread trust is set.
    cwd: homedir(),
  };
  return ChildProcess.make(
    "codex",
    ["app-server", "--stdio", "-c", repositoryTrustOverride(cwd)],
    stdin === undefined ? options : { ...options, stdin },
  );
};

const makeCodexAppServer = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const open: CodexAppServer["Service"]["open"] = Effect.fn("CodexAppServer.open")(
    function* (request) {
      const input = yield* Queue.make<Uint8Array, Cause.Done>();
      const notifications = yield* Queue.make<
        CodexNotification,
        SessionOperationError | Cause.Done
      >();
      const pending = yield* Ref.make(new Map<number, PendingRequest>());
      const nextId = yield* Ref.make(1);
      const closing = yield* Ref.make(false);
      const handle = yield* spawner
        .spawn(
          codexAppServerCommand(request.cwd, {
            stream: Stream.fromQueue(input),
            endOnDone: true,
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            operationError("launch", request, "Codex app-server failed to start", cause),
          ),
        );

      const write = (message: Schema.Json, operation: SessionOperationError["operation"]) =>
        Queue.offer(input, encoder.encode(`${JSON.stringify(message)}\n`)).pipe(
          Effect.flatMap((accepted) =>
            accepted
              ? Effect.void
              : Effect.fail(
                  operationError(
                    operation,
                    request,
                    "Codex app-server input is closed",
                    new Error("input queue closed"),
                  ),
                ),
          ),
          Effect.mapError((cause) =>
            cause instanceof SessionOperationError
              ? cause
              : operationError(operation, request, "Could not write to Codex app-server", cause),
          ),
        );

      const failAll = Effect.fn("CodexAppServer.failAll")(function* (error: SessionOperationError) {
        const waiting = yield* Ref.getAndSet(pending, new Map());
        for (const entry of waiting.values()) yield* Deferred.fail(entry.response, error);
        yield* Queue.fail(notifications, error);
      });

      const routeLine = Effect.fn("CodexAppServer.routeLine")(function* (line: string) {
        const decoded = yield* decodeLine(line).pipe(
          Effect.mapError((cause) =>
            operationError("stream", request, "Codex emitted invalid JSON-RPC", cause),
          ),
        );
        if (Schema.is(RpcResponse)(decoded)) {
          const found = yield* Ref.modify(pending, (entries) => {
            const entry = entries.get(decoded.id);
            if (entry === undefined) return [Option.none<PendingRequest>(), entries];
            const updated = new Map(entries);
            updated.delete(decoded.id);
            return [Option.some(entry), updated];
          });
          if (Option.isNone(found)) return;
          if (Schema.is(RpcErrorResponse)(decoded)) {
            yield* Deferred.fail(
              found.value.response,
              operationError(
                found.value.operation,
                request,
                `Codex app-server rejected ${decoded.error.message}`,
                decoded.error,
              ),
            );
            return;
          }
          yield* Deferred.succeed(found.value.response, decoded.result);
          return;
        }
        if (!Schema.is(RpcMessage)(decoded)) {
          return yield* operationError(
            "stream",
            request,
            "Codex emitted an unknown JSON-RPC message",
            decoded,
          );
        }
        if (decoded.id !== undefined) {
          yield* Effect.logWarning("Codex app-server requested unsupported client input", {
            method: decoded.method,
            sessionId: request.session.id,
          });
          yield* write(
            json({
              id: decoded.id,
              error: { code: -32601, message: "usine runs Codex headlessly" },
            }),
            "stream",
          );
          return;
        }
        yield* Queue.offer(notifications, {
          method: decoded.method,
          params: decoded.params ?? null,
        });
      });

      yield* handle.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach(routeLine),
        Effect.flatMap(() =>
          Ref.get(closing).pipe(
            Effect.flatMap((closed) =>
              closed
                ? Effect.void
                : failAll(
                    operationError(
                      "stream",
                      request,
                      "Codex app-server output closed unexpectedly",
                      new Error("unexpected end of output"),
                    ),
                  ),
            ),
          ),
        ),
        Effect.catch((error) =>
          failAll(
            error instanceof SessionOperationError
              ? error
              : operationError("stream", request, "Could not read Codex app-server output", error),
          ),
        ),
        Effect.forkScoped,
      );
      yield* handle.stderr.pipe(
        Stream.runDrain,
        Effect.mapError((cause) =>
          operationError("stream", request, "Could not read Codex app-server diagnostics", cause),
        ),
        Effect.catch(failAll),
        Effect.forkScoped,
      );
      yield* handle.exitCode.pipe(
        Effect.flatMap((exitCode) =>
          Ref.get(closing).pipe(
            Effect.flatMap((closed) =>
              closed
                ? Effect.void
                : failAll(
                    operationError(
                      "stream",
                      request,
                      `Codex app-server exited with code ${String(exitCode)}`,
                      new Error("app-server exited"),
                    ),
                  ),
            ),
          ),
        ),
        Effect.catch((cause) =>
          failAll(operationError("stream", request, "Could not monitor Codex app-server", cause)),
        ),
        Effect.forkScoped,
      );
      yield* Effect.addFinalizer(() =>
        Effect.logDebug("Closing Codex app-server", { sessionId: request.session.id }).pipe(
          Effect.andThen(Ref.set(closing, true)),
          Effect.andThen(Queue.end(input)),
          Effect.andThen(handle.kill()),
          Effect.catch((cause) =>
            Effect.logWarning("Could not stop Codex app-server cleanly", {
              cause,
              sessionId: request.session.id,
            }),
          ),
        ),
      );

      const requestRpc: CodexConnection["request"] = (operation, method, params) =>
        Effect.gen(function* () {
          const id = yield* Ref.getAndUpdate(nextId, (current) => current + 1);
          const response = yield* Deferred.make<Schema.Json, SessionOperationError>();
          yield* Ref.update(pending, (entries) =>
            new Map(entries).set(id, { operation, response }),
          );
          yield* write(json({ id, method, params }), operation).pipe(
            Effect.tapError(() =>
              Ref.update(pending, (entries) => {
                const updated = new Map(entries);
                updated.delete(id);
                return updated;
              }),
            ),
          );
          return yield* Deferred.await(response);
        });
      const notify: CodexConnection["notify"] = (operation, method, params) =>
        write(json({ method, params }), operation);
      return {
        notifications: Stream.fromQueue(notifications),
        request: requestRpc,
        notify,
      } satisfies CodexConnection;
    },
  );
  return CodexAppServer.of({ open });
});

export const codexAppServerLive = Layer.effect(CodexAppServer, makeCodexAppServer);

const ModelListResponse = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String, model: Schema.String })),
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
const RateLimitsUpdated = Schema.Struct({
  rateLimits: Schema.Struct({
    limitId: Schema.NullOr(Schema.String),
    limitName: Schema.NullOr(Schema.String),
    primary: Schema.NullOr(
      Schema.Struct({
        usedPercent: Schema.Number,
        windowDurationMins: Schema.NullOr(Schema.Number),
        resetsAt: Schema.NullOr(Schema.Number),
      }),
    ),
    secondary: Schema.NullOr(
      Schema.Struct({
        usedPercent: Schema.Number,
        windowDurationMins: Schema.NullOr(Schema.Number),
        resetsAt: Schema.NullOr(Schema.Number),
      }),
    ),
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

const rateLimitWindow = (
  window: Exclude<typeof RateLimitsUpdated.Type.rateLimits.primary, null>,
): Agent.RateLimitWindow =>
  new Agent.RateLimitWindow({
    usedPercent: window.usedPercent,
    windowDurationMinutes: Option.fromNullishOr(window.windowDurationMins),
    resetsAt: Option.fromNullishOr(window.resetsAt).pipe(Option.map(DateTime.fromEpochSeconds)),
  });

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
      if (!models.some((model) => model.id === requestedModel || model.model === requestedModel)) {
        yield* Effect.logError("Codex child rejected an unknown model", { model: requestedModel });
        return yield* new UnknownModelError({
          harness: "codex",
          model: requestedModel,
          message: `Codex does not expose model ${requestedModel}`,
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
      yield* Effect.logDebug("Codex child loaded instruction sources", {
        count: thread.instructionSources.length,
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
      yield* Queue.offer(channel.events, new Agent.SessionStarted({ session }));
      const turnParams: TurnStartParams = {
        threadId: thread.thread.id,
        input: [{ type: "text", text: request.prompt, text_elements: [] }],
        cwd: request.cwd,
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
        effort: request.session.brain.effort === "off" ? "none" : request.session.brain.effort,
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

      const consume = connection.notifications.pipe(
        Stream.runForEach(({ method, params }) =>
          Effect.gen(function* () {
            if (method === "item/started") {
              const notification = yield* decodeResponse(
                ItemNotification,
                "stream",
                request,
                "item notification",
                params,
              );
              if (notification.turnId !== turn.turn.id || !Schema.is(ToolItem)(notification.item)) {
                return;
              }
              yield* Queue.offer(
                channel.events,
                new Agent.ToolStarted({
                  session,
                  callId: notification.item.id,
                  tool: toolName(notification.item),
                  input: notification.item,
                }),
              );
              return;
            }
            if (method === "item/completed") {
              const notification = yield* decodeResponse(
                ItemNotification,
                "stream",
                request,
                "item notification",
                params,
              );
              if (notification.turnId !== turn.turn.id) return;
              if (Schema.is(AgentMessageItem)(notification.item)) {
                const text = notification.item.text.trim();
                if (text.length === 0) return;
                lastText = text;
                yield* Queue.offer(channel.events, new Agent.TextOutput({ session, text }));
                return;
              }
              if (!Schema.is(ToolItem)(notification.item)) return;
              yield* Queue.offer(
                channel.events,
                new Agent.ToolFinished({
                  session,
                  callId: notification.item.id,
                  tool: toolName(notification.item),
                  output: notification.item,
                  isError:
                    notification.item.status === "failed" ||
                    notification.item.status === "declined",
                }),
              );
              return;
            }
            if (method === "account/rateLimits/updated") {
              const notification = yield* decodeResponse(
                RateLimitsUpdated,
                "stream",
                request,
                "rate-limit notification",
                params,
              );
              const snapshot = notification.rateLimits;
              yield* Queue.offer(
                channel.events,
                new Agent.PoolRateLimitsUpdated({
                  session,
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
              return;
            }
            if (method !== "turn/completed") return;
            const completed = yield* decodeResponse(
              TurnCompleted,
              "stream",
              request,
              "turn completion",
              params,
            );
            if (completed.turn.id !== turn.turn.id) return;
            if (completed.turn.status === "completed") {
              yield* channel.finish(session, lastText ?? "Codex child session completed");
              return;
            }
            const detail =
              completed.turn.error?.message ??
              (completed.turn.status === "interrupted"
                ? "Codex child session was interrupted"
                : "Codex child session failed");
            yield* channel.fail(
              new AgentResultError({
                sessionId: Option.some(session.id),
                message: detail,
              }),
            );
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

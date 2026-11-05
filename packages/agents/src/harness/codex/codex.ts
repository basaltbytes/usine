import { checkContinuation, checkContinuationHome, environmentHome } from "../continuation.ts";
import { codexPreflight } from "./preflight.ts";
import { codex } from "./descriptor.ts";
import type { HarnessRuntime } from "../runtime.ts";
import { Harness, BrainSpec, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  ChildSession,
  PoolRateLimitsUpdated,
  ProviderRecovered,
  ProviderRetries,
  ProviderRetrying,
  RateLimitsSnapshot,
  SessionStarted,
  HarnessSession,
  SessionTokensUpdated,
  TextOutput,
  ToolFinished,
  ToolStarted,
} from "@usine/core/agent/session";
import { Deferred, Effect, Layer, Option, Schema, Stream } from "effect";
import {
  AccountUpdated,
  AgentMessageItem,
  CodexTokenUsage,
  ErrorNotification,
  ItemNotification,
  ModelListParams,
  ModelListResponse,
  RateLimitsUpdated,
  ThreadStartParams,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadStartResponse,
  ToolItem,
  TurnActivity,
  TurnCompleted,
  TurnStartParams,
  TurnInterruptParams,
  TurnSteerParams,
  TurnStartResponse,
  UserMessageItem,
} from "../../protocol/codex.ts";
import {
  userMessageText,
  decodeResponse,
  decodeNotification,
  providerRetryMessage,
  turnFailure,
  toolName,
  rateLimitWindow,
} from "./codec.ts";
import {
  type AgentSessionError,
  ChildBackend,
  ChildSessionLifecycle,
  type RunningSession,
  UnknownModelError,
  UnsupportedEffortError,
} from "../../runtime.ts";
import { RemoteCodexProcessLost } from "./remote.ts";
import { sessionChannel } from "../session.ts";
import { type MessageTaken, sessionConversation } from "../conversation.ts";
import { codexThreadTokens, codexTokenBreakdown } from "../usage.ts";
import { CodexAppServer, type CodexClient, operationError } from "./app-server.ts";
import {
  codexChildAccount,
  codexPoolUnavailable,
  initializeCodex,
  verifyCodexAccount,
} from "./account.ts";

export { CodexAppServer, codexAppServerLive, type CodexConnection } from "./app-server.ts";

/** The server notification methods with no session event equivalent; they are only logged. */
const DIAGNOSTIC_METHODS: ReadonlySet<string> = new Set([
  "error",
  "warning",
  "configWarning",
  "deprecationNotice",
  "guardianWarning",
  "model/rerouted",
]);

const decodeRetry = Schema.decodeUnknownOption(ErrorNotification);
const isTurnActivity = Schema.is(TurnActivity);

const makeCodexChild = Effect.gen(function* () {
  const appServer = yield* CodexAppServer;

  const launch: ChildBackend["Service"]["launch"] = Effect.fn("CodexRuntime.launch")(
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
      const lifecycle = yield* ChildSessionLifecycle.current;
      const { home, defaultHome } = environmentHome(request.environment, "CODEX_HOME", ".codex");
      yield* checkContinuationHome(request, home, defaultHome);
      let client: CodexClient = {
        cwd: request.cwd,
        sessionId: Option.some(request.session.id),
        environment: request.environment,
        host: request.host,
      };
      if (Option.isSome(request.resume)) client = { ...client, transport: "replace" };
      let connection = yield* appServer.open(client);
      yield* initializeCodex(connection);
      let billing = yield* codexChildAccount(
        connection,
        request.session.brain,
        request.session.gatewayCredential,
      );

      const models: Array<(typeof ModelListResponse.Type.data)[number]> = [];
      let cursor: string | null = null;
      do {
        const params: ModelListParams = { cursor, includeHidden: true, limit: 100 };
        const encodedModelListParams = yield* Schema.encodeEffect(
          Schema.toCodecJson(ModelListParams),
        )(params).pipe(Effect.orDie);
        const response = yield* connection.request("launch", "model/list", encodedModelListParams);
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
        return yield* UnknownModelError.make({
          harness: Harness.make("codex"),
          model: requestedModel,
          message: `Codex has no model "${requestedModel}"`,
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
        return yield* UnsupportedEffortError.make({
          harness: Harness.make("codex"),
          model: requestedModel,
          effort: request.session.brain.effort,
          message: `Codex model "${requestedModel}" doesn't support effort ${effort}`,
        });
      }

      const thread = yield* Option.match(request.resume, {
        onNone: () =>
          Effect.gen(function* () {
            const params: ThreadStartParams = {
              model: requestedModel,
              allowProviderModelFallback: false,
              cwd: request.cwd,
              approvalPolicy: "never",
              sandbox: "danger-full-access",
              ephemeral: false,
              serviceName: "usine",
            };
            const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(ThreadStartParams))(
              params,
            ).pipe(Effect.orDie);
            const response = yield* connection.request("launch", "thread/start", encoded);
            const started = yield* decodeResponse(
              ThreadStartResponse,
              "launch",
              client,
              "thread start response",
              response,
            );
            return {
              id: started.thread.id,
              model: started.model,
              endpoint: Option.some(started.modelProvider),
            };
          }),
        onSome: (saved) =>
          Effect.gen(function* () {
            const params: ThreadResumeParams = {
              threadId: saved.id,
              model: requestedModel,
              cwd: request.cwd,
              approvalPolicy: "never",
              sandbox: "danger-full-access",
              excludeTurns: false,
            };
            const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(ThreadResumeParams))(
              params,
            ).pipe(Effect.orDie);
            const response = yield* connection.request("launch", "thread/resume", encoded);
            const restored = yield* decodeResponse(
              ThreadResumeResponse,
              "launch",
              client,
              "thread resume response",
              response,
            );
            if (restored.thread.id !== saved.id)
              return yield* operationError(
                "launch",
                client,
                "Codex resumed a different thread",
                restored.thread.id,
              );
            if (Option.isSome(saved.modelProvider))
              yield* checkContinuation(
                request,
                "model_provider",
                saved.modelProvider,
                Option.some(restored.modelProvider),
              );
            yield* Effect.logInfo("Resumed the saved Codex thread", {
              sessionId: request.session.id,
              threadId: saved.id,
            });
            return {
              id: saved.id,
              model: requestedModel,
              endpoint: Option.some(restored.modelProvider),
            };
          }),
      });
      const session = ChildSession.make({
        id: request.session.id,
        parentId: request.session.parentId,
        agent: request.session.agent,
        brain: BrainSpec.make({
          harness: Harness.make("codex"),
          model: ModelId.make(thread.model),
          effort: request.session.brain.effort,
        }),
        gatewayCredential: request.session.gatewayCredential,
        pool: Option.some(billing.pool),
        endpoint: billing.pool === "apiKeys" ? thread.endpoint : Option.none(),
      });
      const channel = yield* sessionChannel({
        label: "Codex child session",
        sessionId: session.id,
      });
      const harnessSession = HarnessSession.make({
        id: thread.id,
        cwd: request.cwd,
        modelProvider: thread.endpoint,
        // Codex saves its sessions under CODEX_HOME, which `codex resume` needs to find them.
        home,
      });
      yield* channel.emit(
        SessionStarted.make({ session, harnessSession: Option.some(harnessSession) }),
      );
      yield* Effect.logInfo("Codex child session saved", {
        pool: billing.pool,
        endpoint: Option.getOrUndefined(session.endpoint),
        sessionId: session.id,
        parentSessionId: session.parentId,
        harnessSessionId: harnessSession.id,
        cwd: harnessSession.cwd,
        ...Option.match(harnessSession.home, { onNone: () => ({}), onSome: (home) => ({ home }) }),
      });
      const turnParams: TurnStartParams = {
        threadId: thread.id,
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
      let replayedGuidance = Option.none<{
        readonly turnId: string;
        readonly text: string;
        readonly count: number;
      }>();
      let lastText: string | undefined;
      let finalText: string | undefined;
      // Provider retries reported for the current turn, and whether the last retry is unresolved.
      let retries = 0;
      let retrying = false;
      const startTurn = Effect.fn("CodexRuntime.startTurn")(function* (message: string) {
        yield* Effect.annotateCurrentSpan({ sessionId: session.id });
        const encodedTurnStartParams = yield* Schema.encodeEffect(
          Schema.toCodecJson(TurnStartParams),
        )({
          ...turnParams,
          input: [{ type: "text", text: message, text_elements: [] }],
        }).pipe(Effect.orDie);
        const response = yield* connection.request("stream", "turn/start", encodedTurnStartParams);
        const started = yield* decodeResponse(
          TurnStartResponse,
          "stream",
          client,
          "turn start response",
          response,
        );
        replayedGuidance = Option.none();
        turnId = started.turn.id;
        turnActive = true;
        lastText = undefined;
        finalText = undefined;
        retries = 0;
        retrying = false;
      });
      const reportRetry = Effect.fn("CodexRuntime.reportRetry")(function* (
        notification: typeof ErrorNotification.Type,
      ) {
        yield* Effect.annotateCurrentSpan({ sessionId: session.id, turnId });
        if (notification.turnId !== turnId) {
          return yield* Effect.logDebug("Skipping a provider retry of another Codex turn", {
            sessionId: session.id,
            turnId: notification.turnId,
          });
        }
        retries += 1;
        retrying = true;
        const message = providerRetryMessage(notification.error);
        yield* Effect.logWarning("Codex child cannot reach its provider and will retry", {
          sessionId: session.id,
          turnId,
          retries,
          message,
        });
        yield* channel.emit(
          ProviderRetrying.make({ session, message, retries: ProviderRetries.make(retries) }),
        );
      });
      const reportRecovery = Effect.fn("CodexRuntime.reportRecovery")(function* () {
        yield* Effect.annotateCurrentSpan({ sessionId: session.id, turnId });
        retrying = false;
        yield* Effect.logInfo("Codex child reached its provider again", {
          sessionId: session.id,
          turnId,
          retries,
        });
        yield* channel.emit(
          ProviderRecovered.make({ session, retries: ProviderRetries.make(retries) }),
        );
      });
      const interruptTurn = Effect.fn("CodexRuntime.interruptTurn")(function* () {
        yield* Effect.annotateCurrentSpan({ sessionId: session.id });
        if ((yield* lifecycle.isStopping) || !turnActive || interrupting) return;
        interrupting = true;
        const encodedTurnInterruptParams = yield* Schema.encodeEffect(
          Schema.toCodecJson(TurnInterruptParams),
        )({
          threadId: thread.id,
          turnId,
        }).pipe(Effect.orDie);
        yield* connection.request("interrupt", "turn/interrupt", encodedTurnInterruptParams).pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              interrupting = false;
            }),
          ),
        );
      });
      const steer: (message: string) => Effect.Effect<MessageTaken, AgentSessionError> = Effect.fn(
        "CodexRuntime.steer",
      )(function* (message) {
        yield* Effect.annotateCurrentSpan({ sessionId: session.id });
        if (interrupting) {
          pendingMessages.push(message);
          return "queued" as const;
        }
        if (!turnActive) {
          const unread = yield* conversation.unread;
          const text = [...unread, message].join("\n\n");
          yield* startTurn(text);
          if (unread.length > 0)
            replayedGuidance = Option.some({ turnId, text, count: unread.length });
          return "read" as const;
        }
        // Codex records steered input as a user message once the running turn reads it.
        const encodedTurnSteerParams = yield* Schema.encodeEffect(
          Schema.toCodecJson(TurnSteerParams),
        )({
          threadId: thread.id,
          expectedTurnId: turnId,
          input: [{ type: "text", text: message, text_elements: [] }],
        }).pipe(Effect.orDie);
        yield* connection.request("steer", "turn/steer", encodedTurnSteerParams);
        return "queued" as const;
      });
      const conversation = yield* sessionConversation({
        session,
        channel,
        held: request.held,
        paused: request.paused,
        idle: request.idle,
        send: steer,
        pause: Effect.suspend(() => (toolsInFlight.size === 0 ? interruptTurn() : Effect.void)),
        beforeFinish: Effect.suspend(() => connection.close),
      });

      const fail = Effect.fn("CodexRuntime.fail")(function* (error: AgentSessionError) {
        if (yield* lifecycle.isStopping) return;
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
      let resumed = false;
      const resume = Effect.fn("CodexRuntime.resume")(function* (error: AgentSessionError) {
        yield* Effect.annotateCurrentSpan({ sessionId: session.id, threadId: thread.id });
        if (yield* lifecycle.isStopping) {
          yield* Effect.logInfo("Leaving the Codex child for reattachment", {
            sessionId: session.id,
          });
          return yield* Effect.never;
        }
        if (
          resumed ||
          request.host._tag !== "RemoteShell" ||
          error._tag !== "SessionOperationError" ||
          !Schema.is(RemoteCodexProcessLost)(error.cause)
        )
          return yield* error;
        resumed = true;
        yield* Effect.logWarning("Remote Codex app-server stopped; resuming its saved thread", {
          sessionId: session.id,
          threadId: thread.id,
        });
        connection = yield* appServer.open({
          ...client,
          sessionId: Option.some(AgentSessionId.make(`${session.id}-resume`)),
        });
        yield* initializeCodex(connection);
        billing = yield* codexChildAccount(
          connection,
          request.session.brain,
          request.session.gatewayCredential,
        );
        const params: ThreadResumeParams = {
          threadId: thread.id,
          model: requestedModel,
          cwd: request.cwd,
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          excludeTurns: false,
        };
        const encodedThreadResumeParams = yield* Schema.encodeEffect(
          Schema.toCodecJson(ThreadResumeParams),
        )(params).pipe(Effect.orDie);
        const response = yield* connection.request(
          "launch",
          "thread/resume",
          encodedThreadResumeParams,
        );
        const restored = yield* decodeResponse(
          ThreadResumeResponse,
          "launch",
          client,
          "thread resume response",
          response,
        );
        if (restored.thread.id !== thread.id)
          return yield* operationError(
            "launch",
            client,
            "Codex resumed a different thread",
            restored.thread.id,
          );
        toolsInFlight.clear();
        pendingMessages.length = 0;
        replayedGuidance = Option.none();
        turnActive = false;
        interrupting = false;
        const paused = yield* conversation.isPaused;
        const idle = yield* conversation.isIdle;
        if (paused || idle) {
          yield* Effect.logInfo("Restored Codex child waits for operator guidance", {
            sessionId: session.id,
            threadId: thread.id,
            paused,
            idle,
          });
          if (!idle) yield* conversation.finish(finalText ?? lastText ?? "Codex turn paused");
          return;
        }
        const taskSaved = restored.thread.turns.some((turn) =>
          turn.items.some((item) => item.type === "userMessage"),
        );
        const unread = yield* conversation.unread;
        yield* Effect.logInfo("Restored Codex child starts a turn", {
          sessionId: session.id,
          threadId: thread.id,
          taskSaved,
          unreadMessages: unread.length,
        });
        yield* startTurn(
          [
            taskSaved
              ? "Continue the interrupted task from this saved thread. Check the checkout and any command results before repeating work."
              : request.prompt,
            ...unread,
          ].join("\n\n"),
        );
        yield* conversation.read(() => unread.length);
      });
      if (!request.paused && Option.isNone(request.idle))
        yield* startTurn(request.prompt).pipe(Effect.catch(resume));
      const consumeNotifications = Stream.unwrap(Effect.sync(() => connection.notifications)).pipe(
        Stream.runForEach(({ method, params }) =>
          Effect.gen(function* () {
            if (method === "error") {
              const retry = decodeRetry(params);
              if (Option.isSome(retry) && retry.value.willRetry)
                return yield* reportRetry(retry.value);
            } else if (retrying && isTurnActivity(params) && params.turnId === turnId) {
              yield* reportRecovery();
            }
            if (method === "thread/tokenUsage/updated") {
              const usage = yield* decodeNotification(
                CodexTokenUsage,
                "token usage",
                session.id,
                params,
              );
              if (Option.isSome(usage) && usage.value.threadId === thread.id) {
                const total = usage.value.tokenUsage.total;
                yield* channel.emit(
                  SessionTokensUpdated.make({
                    session,
                    totalTokens: codexThreadTokens(total),
                    breakdown: Option.some(codexTokenBreakdown(total)),
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
              const item = notification.value.item;
              if (Schema.is(UserMessageItem)(item)) {
                const text = userMessageText(item);
                return yield* conversation.read((queued) => {
                  if (
                    Option.isSome(replayedGuidance) &&
                    replayedGuidance.value.turnId === notification.value.turnId &&
                    replayedGuidance.value.text === text
                  ) {
                    const { count } = replayedGuidance.value;
                    replayedGuidance = Option.none();
                    return count;
                  }
                  return queued.indexOf(text) + 1;
                });
              }
              if (notification.value.turnId !== turnId) {
                return yield* Effect.logDebug("Skipping a Codex item from another turn", {
                  sessionId: session.id,
                  turnId: notification.value.turnId,
                });
              }
              if (!Schema.is(ToolItem)(notification.value.item)) return;
              toolsInFlight.add(notification.value.item.id);
              return yield* channel.emit(
                ToolStarted.make({
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
                return yield* channel.emit(TextOutput.make({ session, text }));
              }
              if (!Schema.is(ToolItem)(item)) return;
              toolsInFlight.delete(item.id);
              yield* channel.emit(
                ToolFinished.make({
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
              if (Option.isSome(request.session.gatewayCredential))
                return yield* Effect.logDebug(
                  "Skipping a Codex account change: the Gateway holds the OpenAI credential",
                  { sessionId: session.id },
                );
              const account = yield* Schema.decodeUnknownEffect(AccountUpdated)(params).pipe(
                Effect.mapError(() => codexPoolUnavailable(request.session.brain.model)),
              );
              if (
                account.authMode !== (billing.pool === "apiKeys" ? "apikey" : "chatgpt") &&
                !(billing.pool === "chatgptPlan" && account.authMode === "chatgptAuthTokens")
              ) {
                yield* Effect.logError("Codex authentication changed during the session", {
                  sessionId: session.id,
                  authentication: account.authMode ?? "logged-out",
                  requiredPool: billing.pool,
                });
                return yield* codexPoolUnavailable(request.session.brain.model);
              }
              billing = yield* verifyCodexAccount(connection, request.session.brain.model);
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
                PoolRateLimitsUpdated.make({
                  session,
                  pool: billing.pool,
                  login: billing.login,
                  rateLimits: RateLimitsSnapshot.make({
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
              if (retrying && completed.turn.status === "completed") yield* reportRecovery();
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
                  yield* conversation.read((queued) => queued.indexOf(nextMessage) + 1);
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
              return yield* fail(turnFailure(session.id, completed.turn.error, detail));
            }
            if (DIAGNOSTIC_METHODS.has(method)) {
              return yield* Effect.logWarning("Codex reported a diagnostic", {
                method,
                params,
                sessionId: session.id,
              });
            }
            // Streaming deltas duplicate the content of completed items.
            if (method.toLowerCase().includes("delta")) return;
            yield* Effect.logDebug("Ignoring an unhandled Codex notification", {
              method,
              sessionId: session.id,
            });
          }),
        ),
      );
      const consume = consumeNotifications.pipe(
        Effect.catch((error) => resume(error).pipe(Effect.andThen(consumeNotifications))),
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
        steer: (message: string) => steer(message).pipe(Effect.asVoid),
        intervene: conversation.intervene,
      } satisfies RunningSession;
    },
  );
  return ChildBackend.of({ launch });
});

/** Provides `ChildBackend` for local or remote children. Requires `CodexAppServer`; validates the model and authentication before starting the task. */
export const codexChildLayer = Layer.effect(ChildBackend, makeCodexChild);

export { codexConfigArgs } from "./app-server.ts";

/** Combines preflight and scoped launch for registration. */
export const codexRuntime = Effect.gen(function* () {
  const child = yield* makeCodexChild;
  const preflight = yield* codexPreflight;
  return { id: codex.id, preflight, launch: child.launch } satisfies HarnessRuntime;
});

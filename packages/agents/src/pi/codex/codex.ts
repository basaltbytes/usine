import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import {
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
  type ModelListParams,
  ModelListResponse,
  RateLimitsUpdated,
  type ThreadStartParams,
  ThreadStartResponse,
  ToolItem,
  TurnActivity,
  TurnCompleted,
  type TurnStartParams,
  TurnStartResponse,
  UserMessageItem,
} from "../../protocol/codex.ts";
import {
  json,
  userMessageText,
  decodeResponse,
  decodeNotification,
  providerRetryMessage,
  toolName,
  rateLimitWindow,
} from "./codec.ts";
import {
  AgentResultError,
  type AgentSessionError,
  CodexChildBackend,
  type RunningSession,
  UnknownModelError,
  UnsupportedEffortError,
} from "../../runtime.ts";
import { sessionChannel } from "../session.ts";
import { sessionConversation } from "../conversation.ts";
import { codexThreadTokens, codexTokenBreakdown } from "../usage.ts";
import { CodexAppServer, type CodexClient, operationError } from "./app-server.ts";
import { codexChildPool, codexPoolUnavailable, initializeCodex } from "./account.ts";

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
      const client: CodexClient = {
        cwd: request.cwd,
        sessionId: Option.some(request.session.id),
        environment: request.environment,
        host: request.host,
      };
      const connection = yield* appServer.open(client);
      yield* initializeCodex(connection);
      const pool = yield* codexChildPool(
        connection,
        request.session.brain,
        request.session.gatewayCredential,
      );

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
        return yield* new UnsupportedEffortError({
          harness: "codex",
          model: requestedModel,
          effort: request.session.brain.effort,
          message: `Codex model "${requestedModel}" doesn't support effort ${effort}`,
        });
      }

      const threadParams: ThreadStartParams = {
        model: requestedModel,
        allowProviderModelFallback: false,
        cwd: request.cwd,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        ephemeral: false,
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
        gatewayCredential: request.session.gatewayCredential,
      });
      const channel = yield* sessionChannel({
        label: "Codex child session",
        sessionId: session.id,
      });
      const harnessSession = new HarnessSession({ id: thread.thread.id, cwd: request.cwd });
      yield* channel.emit(
        new SessionStarted({ session, harnessSession: Option.some(harnessSession) }),
      );
      yield* Effect.logInfo("Codex child session saved", {
        sessionId: session.id,
        parentSessionId: session.parentId,
        harnessSessionId: harnessSession.id,
        cwd: harnessSession.cwd,
      });
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
      // Provider retries reported for the current turn, and whether the last retry is unresolved.
      let retries = 0;
      let retrying = false;
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
        retries = 0;
        retrying = false;
      });
      const reportRetry = Effect.fn("CodexChildBackend.reportRetry")(function* (
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
          new ProviderRetrying({ session, message, retries: ProviderRetries.make(retries) }),
        );
      });
      const reportRecovery = Effect.fn("CodexChildBackend.reportRecovery")(function* () {
        yield* Effect.annotateCurrentSpan({ sessionId: session.id, turnId });
        retrying = false;
        yield* Effect.logInfo("Codex child reached its provider again", {
          sessionId: session.id,
          turnId,
          retries,
        });
        yield* channel.emit(
          new ProviderRecovered({ session, retries: ProviderRetries.make(retries) }),
        );
      });
      const interruptTurn = Effect.fn("CodexChildBackend.interruptTurn")(function* () {
        yield* Effect.annotateCurrentSpan({ sessionId: session.id });
        if (!turnActive || interrupting) return;
        interrupting = true;
        yield* connection
          .request("interrupt", "turn/interrupt", json({ threadId: thread.thread.id, turnId }))
          .pipe(
            Effect.onError(() =>
              Effect.sync(() => {
                interrupting = false;
              }),
            ),
          );
      });
      const steer = Effect.fn("CodexChildBackend.steer")(function* (message: string) {
        yield* Effect.annotateCurrentSpan({ sessionId: session.id });
        if (interrupting) {
          pendingMessages.push(message);
          return "queued" as const;
        }
        if (!turnActive) {
          yield* startTurn(message);
          return "read" as const;
        }
        // Codex records steered input as a user message once the running turn reads it.
        yield* connection.request(
          "steer",
          "turn/steer",
          json({
            threadId: thread.thread.id,
            expectedTurnId: turnId,
            input: [{ type: "text", text: message, text_elements: [] }],
          }),
        );
        return "queued" as const;
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
              if (Option.isSome(usage) && usage.value.threadId === thread.thread.id) {
                const total = usage.value.tokenUsage.total;
                yield* channel.emit(
                  new SessionTokensUpdated({
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
                return yield* conversation.read((queued) => queued.indexOf(text) + 1);
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
              if (Option.isSome(request.session.gatewayCredential))
                return yield* Effect.logDebug(
                  "Skipping a Codex account change: the Gateway holds the OpenAI credential",
                  { sessionId: session.id },
                );
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
            // Streaming deltas duplicate the content of completed items.
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
        steer: (message: string) => steer(message).pipe(Effect.asVoid),
        intervene: conversation.intervene,
      } satisfies RunningSession;
    },
  );
  return CodexChildBackend.of({ launch });
});

export const codexChildBackendLayer = Layer.effect(CodexChildBackend, makeCodexChild);

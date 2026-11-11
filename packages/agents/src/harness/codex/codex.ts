import type { OperatorMessageId } from "@usine/core/attempt/channel";
import {
  childContinuation,
  type ChildAdapter,
  checkContinuation,
  checkContinuationHome,
  environmentHome,
} from "../continuation.ts";
import { codexPreflight } from "./preflight.ts";
import { codex } from "./descriptor.ts";
import type { HarnessRuntime } from "../runtime.ts";
import { Harness, BrainSpec, ModelId } from "@usine/core/agent/brain";
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
import { Array as Arr, Deferred, Effect, Layer, Option, Schema, Stream } from "effect";
import {
  AccountUpdated,
  AgentMessageItem,
  CodexTokenUsage,
  ErrorNotification,
  ItemNotification,
  isApprovalToolStatus,
  isAuthMode,
  isMessagePhase,
  isToolStatus,
  isTurnStatus,
  ModelListParams,
  ModelListResponse,
  RateLimitsUpdated,
  ThreadStartParams,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadStartResponse,
  TurnActivity,
  TurnCompleted,
  TurnStartParams,
  TurnInterruptParams,
  TurnSteerParams,
  TurnStartResponse,
  UserMessageItem,
} from "../../protocol/codex/codex.ts";
import {
  userMessageText,
  AgentMessageKindItem,
  decodeItem,
  decodeResponse,
  decodeNotification,
  decodeNotifiedToolItem,
  decodeToolItem,
  providerRetryMessage,
  turnFailure,
  toolName,
  rateLimitWindow,
  UserMessageKindItem,
} from "./codec.ts";
import {
  type AgentSessionError,
  ChildBackend,
  type ChildRequest,
  type InterruptedTool,
  ChildSessionLifecycle,
  ChildSessionJournal,
  type RunningSession,
  UnknownModelError,
  UnsupportedEffortError,
} from "../../runtime.ts";
import { isRemoteHost } from "../../child-host/child-host.ts";
import { ChildProcessLost } from "../../child-host/process.ts";
import { sessionChannel } from "../session.ts";
import { type MessageTaken, sessionConversation } from "../conversation.ts";
import { codexThreadTokens, codexTokenBreakdown } from "../usage.ts";
import {
  CodexAppServer,
  type CodexClient,
  type CodexConnection,
  operationError,
} from "./app-server.ts";
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

const resumeThread = Effect.fn("CodexRuntime.resumeThread")(function* (
  connection: CodexConnection,
  client: CodexClient,
  request: ChildRequest,
  saved: HarnessSession,
) {
  const params: ThreadResumeParams = {
    threadId: saved.id,
    model: request.session.brain.model,
    cwd: request.cwd,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    excludeTurns: false,
  };
  const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(ThreadResumeParams))(params).pipe(
    Effect.orDie,
  );
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
    empty: restored.thread.turns.length === 0,
    model: request.session.brain.model,
    endpoint: Option.some(restored.modelProvider),
    activeTurn: Option.fromUndefinedOr(
      restored.thread.turns.find((turn) => isTurnStatus(turn.status, "inProgress")),
    ),
  };
});

const makeCodexChild = Effect.gen(function* () {
  const appServer = yield* CodexAppServer;

  const open: ChildAdapter["open"] = Effect.fn("CodexRuntime.open")(
    function* (request, prompt, policy) {
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
      let client: CodexClient = {
        cwd: request.cwd,
        sessionId: Option.some(request.session.id),
        environment: request.environment,
        host: request.host,
      };
      if (Option.isSome(request.resume)) client = { ...client, transport: "resume" };
      let connection = yield* appServer.open(client);
      yield* checkContinuationHome(request, home, defaultHome);
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
        cursor = page.nextCursor ?? null;
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
              empty: true,
              model: started.model,
              endpoint: Option.some(started.modelProvider),
              activeTurn: Option.none<(typeof ThreadResumeResponse.Type.thread.turns)[number]>(),
            };
          }),
        onSome: (saved) => resumeThread(connection, client, request, saved),
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
      const journal = yield* ChildSessionJournal.current;
      yield* journal.started(harnessSession);
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
      let turnId = Option.match(thread.activeTurn, { onNone: () => "", onSome: (turn) => turn.id });
      let turnActive = Option.isSome(thread.activeTurn);
      let interrupting = false;
      const resumedTools = yield* Effect.forEach(
        Option.match(thread.activeTurn, { onNone: () => [], onSome: (turn) => turn.items }),
        (item) => decodeToolItem(session.id, item),
      ).pipe(Effect.map(Arr.getSomes));
      const toolsInFlight = new Map<string, string>(
        resumedTools
          .filter((item) => isToolStatus(item.status, "inProgress"))
          .map((item): [string, string] => [item.id, toolName(item)]),
      );
      const pendingMessages: Array<{ message: string; id: OperatorMessageId | undefined }> = [];
      const submitted: Array<{
        message: string;
        id: OperatorMessageId | undefined;
        turnId: string | undefined;
      }> = turnActive ? request.unread.map((message) => ({ ...message, turnId })) : [];
      const forgetInput = (input: (typeof submitted)[number]) =>
        Effect.sync(() => {
          const index = submitted.indexOf(input);
          if (index >= 0) submitted.splice(index, 1);
        });
      const observedItems = new Set<string>();
      const savedMessages = yield* Effect.forEach(
        Option.match(thread.activeTurn, { onNone: () => [], onSome: (turn) => turn.items }),
        (item) =>
          Schema.is(AgentMessageKindItem)(item)
            ? decodeItem(AgentMessageItem, "agent message", session.id, item)
            : Effect.succeedNone,
      ).pipe(
        Effect.map((items) => Arr.getSomes(items).filter((item) => item.text.trim().length > 0)),
      );
      let lastText = savedMessages.at(-1)?.text.trim();
      let finalText = savedMessages
        .filter((item) => isMessagePhase(item.phase, "final_answer"))
        .at(-1)
        ?.text.trim();
      // Provider retries reported for the current turn, and whether the last retry is unresolved.
      let retries = 0;
      let retrying = false;
      const startTurn = Effect.fn("CodexRuntime.startTurn")(function* (
        message: string,
        id?: OperatorMessageId,
      ) {
        yield* Effect.annotateCurrentSpan({ sessionId: session.id });
        const encodedTurnStartParams = yield* Schema.encodeEffect(
          Schema.toCodecJson(TurnStartParams),
        )({
          ...turnParams,
          input: [{ type: "text", text: message, text_elements: [] }],
        }).pipe(Effect.orDie);
        const input: (typeof submitted)[number] = { message, id, turnId: undefined };
        submitted.push(input);
        const response = yield* connection
          .request("stream", "turn/start", encodedTurnStartParams)
          .pipe(Effect.onError(() => forgetInput(input)));
        const started = yield* decodeResponse(
          TurnStartResponse,
          "stream",
          client,
          "turn start response",
          response,
        );
        turnId = started.turn.id;
        input.turnId = turnId;
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
      const steer: (
        message: string,
        id?: OperatorMessageId,
      ) => Effect.Effect<MessageTaken, AgentSessionError> = Effect.fn("CodexRuntime.steer")(
        function* (message, id) {
          yield* Effect.annotateCurrentSpan({ sessionId: session.id });
          if (interrupting) {
            pendingMessages.push({ message, id });
            return "queued" as const;
          }
          if (!turnActive) {
            const messages = [...pendingMessages.splice(0), { message, id }];
            for (const input of messages) {
              if (!turnActive) yield* startTurn(input.message, input.id);
              else yield* steer(input.message, input.id);
            }
            return "queued" as const;
          }
          // Codex records steered input as a user message once the running turn reads it.
          const encodedTurnSteerParams = yield* Schema.encodeEffect(
            Schema.toCodecJson(TurnSteerParams),
          )({
            threadId: thread.id,
            expectedTurnId: turnId,
            input: [{ type: "text", text: message, text_elements: [] }],
          }).pipe(Effect.orDie);
          const input = { message, id, turnId };
          submitted.push(input);
          yield* connection
            .request("steer", "turn/steer", encodedTurnSteerParams)
            .pipe(Effect.onError(() => forgetInput(input)));
          return "queued" as const;
        },
      );
      const conversation = yield* sessionConversation({
        session,
        channel,
        held: request.held,
        paused: request.paused,
        idle: request.idle,
        unread: request.unread,
        submitted: submitted.flatMap(({ id }) => (id === undefined ? [] : [id])),
        send: (message, _activity, id) => steer(message, id),
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
      const resume = Effect.fn("CodexRuntime.resume")(function* (error: AgentSessionError) {
        yield* Effect.annotateCurrentSpan({ sessionId: session.id, threadId: thread.id });
        if (yield* lifecycle.isStopping) return yield* Effect.never;
        if (
          !isRemoteHost(request.host) ||
          error._tag !== "SessionOperationError" ||
          !Schema.is(ChildProcessLost)(error.cause)
        )
          return yield* error;
        yield* Effect.logWarning("Remote Codex app-server stopped; resuming its saved thread", {
          sessionId: session.id,
          threadId: thread.id,
        });
        const restored = yield* policy.reopen(
          Effect.gen(function* () {
            connection = yield* appServer.open({
              ...client,
              sessionId: Option.some(session.id),
              transport: "replace",
            });
            yield* initializeCodex(connection);
            billing = yield* codexChildAccount(
              connection,
              request.session.brain,
              request.session.gatewayCredential,
            );
            return yield* resumeThread(connection, client, request, harnessSession);
          }),
        );
        const interruptedTools = [...toolsInFlight].map(([callId, tool]) => ({ callId, tool }));
        toolsInFlight.clear();
        pendingMessages.length = 0;
        submitted.length = 0;
        turnActive = false;
        interrupting = false;
        yield* conversation.recover(
          policy,
          interruptedTools,
          (message, id) => steer(message, id).pipe(Effect.asVoid),
          restored.empty,
        );
      });
      if (turnActive) {
        yield* Effect.logInfo("Reattached the active Codex turn", {
          sessionId: session.id,
          turnId,
        });
        if (request.paused && toolsInFlight.size === 0) yield* interruptTurn();
      } else if (!request.paused && Option.isNone(request.idle) && Option.isSome(prompt))
        yield* startTurn(prompt.value).pipe(Effect.catch(resume));
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
              if (notification.value.threadId !== thread.id) return;
              if (Schema.is(UserMessageKindItem)(item)) {
                const message = yield* decodeItem(
                  UserMessageItem,
                  "user message",
                  session.id,
                  item,
                );
                if (Option.isNone(message)) return;
                const text = userMessageText(message.value);
                if (observedItems.has(message.value.id)) return;
                observedItems.add(message.value.id);
                const index = submitted.findIndex(
                  (input) =>
                    (input.turnId === undefined || input.turnId === notification.value.turnId) &&
                    input.message === text,
                );
                if (index < 0) return;
                const [input] = submitted.splice(index, 1);
                if (input?.id !== undefined) yield* conversation.read([input.id]);
                return;
              }
              if (notification.value.turnId !== turnId) {
                return yield* Effect.logDebug("Skipping a Codex item from another turn", {
                  sessionId: session.id,
                  turnId: notification.value.turnId,
                });
              }
              const tool = yield* decodeNotifiedToolItem(session.id, item);
              if (Option.isNone(tool)) return;
              toolsInFlight.set(tool.value.id, toolName(tool.value));
              return yield* channel.emit(
                ToolStarted.make({
                  session,
                  callId: tool.value.id,
                  tool: toolName(tool.value),
                  input: item,
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
              if (Schema.is(AgentMessageKindItem)(item)) {
                const message = yield* decodeItem(
                  AgentMessageItem,
                  "agent message",
                  session.id,
                  item,
                );
                if (Option.isNone(message)) return;
                const text = message.value.text.trim();
                if (text.length === 0) return;
                lastText = text;
                if (isMessagePhase(message.value.phase, "final_answer")) finalText = text;
                return yield* channel.emit(TextOutput.make({ session, text }));
              }
              const tool = yield* decodeNotifiedToolItem(session.id, item);
              if (Option.isNone(tool)) return;
              toolsInFlight.delete(tool.value.id);
              yield* channel.emit(
                ToolFinished.make({
                  session,
                  callId: tool.value.id,
                  tool: toolName(tool.value),
                  output: item,
                  isError:
                    isToolStatus(tool.value.status, "failed") ||
                    isApprovalToolStatus(tool.value.status, "declined") ||
                    tool.value.success === false,
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
                !isAuthMode(account.authMode, billing.pool === "apiKeys" ? "apikey" : "chatgpt") &&
                !(
                  billing.pool === "chatgptPlan" &&
                  isAuthMode(account.authMode, "chatgptAuthTokens")
                )
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
              if (retrying && isTurnStatus(completed.turn.status, "completed"))
                yield* reportRecovery();
              turnActive = false;
              const wasInterrupted = interrupting;
              interrupting = false;
              toolsInFlight.clear();
              const hasNewGuidance = pendingMessages.length > 0;
              const unread = submitted.splice(0).filter((input) => input.id !== undefined);
              pendingMessages.unshift(...unread);
              if (unread.length > 0)
                yield* Effect.logInfo("Codex turn ended with unconsumed input", {
                  sessionId: session.id,
                  turnId,
                  unread: unread.length,
                });
              if (
                isTurnStatus(completed.turn.status, "completed") ||
                (isTurnStatus(completed.turn.status, "interrupted") &&
                  wasInterrupted &&
                  ((yield* conversation.isPaused) || hasNewGuidance))
              ) {
                if (hasNewGuidance) {
                  const nextMessage = pendingMessages.pop();
                  if (nextMessage !== undefined) yield* steer(nextMessage.message, nextMessage.id);
                  return;
                }
                return yield* conversation.finish(finalText ?? lastText ?? "Codex turn paused");
              }
              const detail =
                completed.turn.error?.message ??
                (isTurnStatus(completed.turn.status, "interrupted")
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
      const consume = Effect.gen(function* () {
        for (;;) {
          const consumed = yield* Effect.result(consumeNotifications);
          if ((yield* channel.isTerminal) || (yield* conversation.isClosing)) return;
          if (consumed._tag === "Success")
            return yield* fail(
              operationError(
                "stream",
                client,
                "Codex notification stream closed without a result",
                new Error("unexpected end of notifications"),
              ),
            );
          yield* resume(consumed.failure);
        }
      }).pipe(Effect.catch(fail));
      yield* Effect.forkScoped(consume);

      const interrupt = interruptTurn();
      const running = {
        session,
        events: Stream.fromQueue(channel.events),
        interrupt,
        result: Deferred.await(channel.result),
        steer: (message: string, id?: OperatorMessageId) => steer(message, id).pipe(Effect.asVoid),
        intervene: conversation.intervene,
      } satisfies RunningSession;
      return {
        running,
        active: turnActive,
        recover: (tools: ReadonlyArray<InterruptedTool>) =>
          conversation.recover(policy, tools, running.steer, thread.empty),
      };
    },
  );
  const stop = Effect.fn("CodexRuntime.stop")((request: ChildRequest) =>
    appServer.stop({ ...request, sessionId: Option.some(request.session.id) }),
  );
  return childContinuation({ open, stop });
});

/** Provides `ChildBackend` for local or remote children. Requires `CodexAppServer`; validates the model and authentication before starting the task. */
export const codexChildLayer = Layer.effect(ChildBackend, makeCodexChild);

export { codexConfigArgs } from "./app-server.ts";

/** Combines preflight and scoped launch for registration. */
export const codexRuntime = Effect.gen(function* () {
  const child = yield* makeCodexChild;
  const preflight = yield* codexPreflight;
  return {
    id: codex.id,
    preflight,
    launch: child.launch,
    resume: child.resume,
    stop: child.stop,
  } satisfies HarnessRuntime;
});

import type { OperatorMessageId } from "@usine/core/attempt/channel";
import { childContinuation, checkContinuationHome, environmentHome } from "../continuation.ts";
import { codexPreflight } from "./preflight.ts";
import { codex } from "./descriptor.ts";
import { type HarnessRuntime, openWithTools } from "../runtime.ts";
import { type SessionSpec, type Start } from "../contract.ts";
import type { ContinuationPolicy } from "../continuation.ts";
import type { HostToolSet } from "../tools.ts";
import {
  gatewayCredential,
  parentFields,
  resolvedSession,
  startPrompt,
  startReference,
} from "../adapter.ts";
import { HarnessCatalog } from "../harness.ts";
import { Harness, BrainSpec, ModelId } from "@usine/core/agent/brain";
import {
  type BillingPool,
  type PoolLogin,
  PoolRateLimitsUpdated,
  ProviderAnswered,
  ProviderRecovered,
  ProviderRetries,
  ProviderRetrying,
  type RateLimitsSnapshot,
  SessionStarted,
  HarnessSession,
  SessionTokensUpdated,
  TextOutput,
  ToolFinished,
  ToolStarted,
} from "@usine/core/agent/session";
import {
  Array as Arr,
  Deferred,
  Effect,
  Layer,
  Option,
  Ref,
  Schema,
  Semaphore,
  Stream,
} from "effect";
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
  RateLimitsUpdated,
  ThreadStartParams,
  ThreadStartResponse,
  TurnCompleted,
  TurnStartParams,
  TurnInterruptParams,
  TurnSteerParams,
  TurnStartResponse,
  UserMessageItem,
} from "../../protocol/codex/codex.ts";
import {
  AgentMessageKindItem,
  decodeItem,
  decodeResponse,
  decodeNotification,
  decodeNotifiedToolItem,
  providerRetryMessage,
  failedTurn,
  DIAGNOSTIC_METHODS,
  decodeRetry,
  ModelKindItem,
  rateLimitsSnapshot,
  UserMessageKindItem,
  codexReceipts,
} from "./codec.ts";
import {
  type AgentSessionError,
  ChildBackend,
  type InterruptedTool,
  ChildSessionLifecycle,
  type RunningSession,
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
import { structuredCompletion } from "../completion.ts";
import { codexCompletion } from "./completion.ts";
import { checkCodexModel } from "./model.ts";
import { serveCodexTools } from "./tools.ts";
import { readRestored, restoredState, resumeThread, type RestoredTurn } from "./restored.ts";
import {
  codexChildAccount,
  codexPoolUnavailable,
  initializeCodex,
  verifyCodexAccount,
} from "./account.ts";

export { CodexAppServer, codexAppServerLive, type CodexConnection } from "./app-server.ts";

/** An input that the session sent to a Codex turn, or holds for the next one. */
interface TurnInput {
  readonly message: string;
  /** The operator message that the input carries, or `undefined` for the session's own input. */
  readonly id: OperatorMessageId | undefined;
}

/** What a Codex child session tracks about its app-server and turns. */
interface CodexState {
  /** The app-server connection; a process resume replaces it. */
  readonly connection: CodexConnection;
  /** The account's billing pool and login, which an account change verifies again. */
  readonly billing: { readonly pool: BillingPool; readonly login: Option.Option<PoolLogin> };
  /** The ID of the latest turn, or empty before the first. */
  readonly turnId: string;
  /** Whether a turn runs; `turn/start` answers before it does. */
  readonly turnActive: boolean;
  /** Whether the session asked Codex to interrupt the running turn. */
  readonly interrupting: boolean;
  /** The tool calls of the running turn that started and haven't finished, by item ID. */
  readonly toolsInFlight: ReadonlyMap<string, string>;
  /** The inputs that wait for an interrupted turn to end. */
  readonly pending: ReadonlyArray<TurnInput>;
  /** The inputs sent to the running turn, which the next turn carries if this one doesn't read them. */
  readonly submitted: ReadonlyArray<TurnInput>;
  /** Whether the session saved the user-message items that it counted, so restored ones acknowledge input. */
  readonly receiptsKnown: boolean;
  /** The text of the turn's last agent message. */
  readonly lastText: Option.Option<string>;
  /** The text of the turn's last final answer. */
  readonly finalText: Option.Option<string>;
  /** The provider retries reported for the current turn. */
  readonly retries: number;
  /** Whether the last provider retry is unresolved. */
  readonly retrying: boolean;
  /** The account's latest rate-limit snapshot, which dates a usage limit's reset. */
  readonly rateLimits: Option.Option<RateLimitsSnapshot>;
  /** Whether the model answered since the current app-server process started. */
  readonly answered: boolean;
}

const makeCodexSessions = Effect.gen(function* () {
  const appServer = yield* CodexAppServer;

  const open = Effect.fn("CodexRuntime.open")(function* (
    spec: SessionSpec,
    start: Start,
    policy: ContinuationPolicy,
    hostTools: HostToolSet,
  ) {
    const prompt = startPrompt(start);
    yield* Effect.annotateCurrentSpan({
      agent: spec.session.agent,
      effort: spec.session.brain.effort,
      harness: spec.session.brain.harness,
      model: spec.session.brain.model,
      ...parentFields(spec.session),
      sessionId: spec.session.id,
    });
    yield* Effect.logInfo("Launching Codex child session", {
      usineTools: hostTools.tools.length,
    });
    const lifecycle = yield* ChildSessionLifecycle.current;
    const { home, defaultHome } = environmentHome(spec.environment, "CODEX_HOME", ".codex");
    const tools = yield* serveCodexTools(hostTools, spec.session.id);
    // Registering usine tools on a thread is an experimental app-server field.
    const initialization = { experimentalApi: Option.isSome(tools.dynamicTools) };
    const launch: CodexClient = {
      cwd: spec.cwd,
      sessionId: Option.some(spec.session.id),
      environment: spec.environment,
      host: spec.host,
      protocolFrameMib: Option.getOrUndefined(spec.protocolFrameMib),
      serve: tools.serve,
    };
    const client: CodexClient =
      start._tag === "StartResume" ? { ...launch, transport: "resume" } : launch;
    const connection = yield* appServer.open(client);
    yield* checkContinuationHome(spec, start, home, defaultHome);
    yield* initializeCodex(connection, initialization);
    const billing = yield* codexChildAccount(connection, spec.session.brain, spec.admitted.pool);

    const effort = yield* checkCodexModel(connection, client, spec);
    const requestedModel = spec.session.brain.model;
    const thread = yield* Option.match(startReference(start), {
      onNone: () =>
        Effect.gen(function* () {
          const params: ThreadStartParams = {
            model: requestedModel,
            allowProviderModelFallback: false,
            cwd: spec.cwd,
            approvalPolicy: "never",
            sandbox: "danger-full-access",
            ephemeral: false,
            serviceName: "usine",
            ...Option.match(tools.dynamicTools, {
              onNone: () => ({}),
              onSome: (dynamicTools) => ({ dynamicTools }),
            }),
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
            activeTurn: Option.none<RestoredTurn>(),
            lastTurn: Option.none<RestoredTurn>(),
          };
        }),
      onSome: (saved) => resumeThread(connection, client, spec, saved),
    });
    const session = resolvedSession(spec.session, {
      brain: BrainSpec.make({
        harness: Harness.make("codex"),
        model: ModelId.make(thread.model),
        effort: spec.session.brain.effort,
      }),
      pool: Option.some(billing.pool),
      endpoint: billing.pool === "apiKeys" ? thread.endpoint : Option.none(),
    });
    const channel = yield* sessionChannel({
      label: "Codex child session",
      sessionId: session.id,
    });
    const harnessSession = HarnessSession.make({
      id: thread.id,
      cwd: spec.cwd,
      modelProvider: thread.endpoint,
      // Codex saves its sessions under CODEX_HOME, which `codex resume` needs to find them.
      home,
    });
    const journal = policy.journal;
    yield* journal.started(harnessSession);
    /** Records once that Codex started a turn, whose input its thread saves. */
    const recordPrompt = yield* Effect.cached(
      journal.prompted.pipe(
        Effect.tap(() =>
          Effect.logDebug("Codex started the child's first turn", { sessionId: session.id }),
        ),
        Effect.catch((error) =>
          Effect.logWarning("Could not record the Codex prompt receipt", {
            sessionId: session.id,
            message: error.message,
          }),
        ),
      ),
    );
    yield* channel.emit(
      SessionStarted.make({ session, harnessSession: Option.some(harnessSession) }),
    );
    yield* Effect.logInfo("Codex child session saved", {
      pool: billing.pool,
      endpoint: Option.getOrUndefined(session.endpoint),
      sessionId: session.id,
      ...parentFields(session),
      harnessSessionId: harnessSession.id,
      cwd: harnessSession.cwd,
      ...Option.match(harnessSession.home, { onNone: () => ({}), onSome: (home) => ({ home }) }),
    });
    const turnParams: Omit<TurnStartParams, "input"> = {
      threadId: thread.id,
      cwd: spec.cwd,
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      effort,
    };
    const { items, ...fromThread } = yield* restoredState(
      session.id,
      thread,
      start,
      policy.restored,
      tools.toolName,
    );
    const state = yield* Ref.make<CodexState>({
      ...fromThread,
      connection,
      billing,
      turnId: Option.match(thread.activeTurn, { onNone: () => "", onSome: (turn) => turn.id }),
      turnActive: Option.isSome(thread.activeTurn),
      interrupting: false,
      pending: [],
      submitted: Option.isSome(thread.activeTurn) ? policy.restored.unread : [],
      retries: 0,
      retrying: false,
      rateLimits: Option.none(),
      answered: false,
    });
    const forgetInput = (input: TurnInput) =>
      Ref.update(state, (current) => ({
        ...current,
        submitted: current.submitted.filter((submitted) => submitted !== input),
      }));
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
      const input: TurnInput = { message, id };
      const { connection } = yield* Ref.updateAndGet(state, (current) => ({
        ...current,
        submitted: [...current.submitted, input],
      }));
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
      yield* Ref.update(state, (current) => ({
        ...current,
        turnId: started.turn.id,
        turnActive: true,
        lastText: Option.none(),
        finalText: Option.none(),
        retries: 0,
        retrying: false,
      }));
      yield* recordPrompt;
    });
    const reportRetry = Effect.fn("CodexRuntime.reportRetry")(function* (
      notification: typeof ErrorNotification.Type,
    ) {
      const { turnId } = yield* Ref.get(state);
      yield* Effect.annotateCurrentSpan({ sessionId: session.id, turnId });
      if (notification.turnId !== turnId) {
        return yield* Effect.logDebug("Skipping a provider retry of another Codex turn", {
          sessionId: session.id,
          turnId: notification.turnId,
        });
      }
      const retries = yield* Ref.modify(state, (current) => [
        current.retries + 1,
        { ...current, retries: current.retries + 1, retrying: true },
      ]);
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
      const { turnId, retries } = yield* Ref.getAndUpdate(state, (current) => ({
        ...current,
        retrying: false,
      }));
      yield* Effect.annotateCurrentSpan({ sessionId: session.id, turnId });
      yield* Effect.logInfo("Codex child reached its provider again", {
        sessionId: session.id,
        turnId,
        retries,
      });
      yield* channel.emit(
        ProviderRecovered.make({ session, retries: ProviderRetries.make(retries) }),
      );
    });
    /** Reports model output in the current turn: a recovery after retries, and a first answer. */
    const reportModelOutput = Effect.fn("CodexRuntime.reportModelOutput")(function* () {
      const { turnId, retrying } = yield* Ref.get(state);
      yield* Effect.annotateCurrentSpan({ sessionId: session.id, turnId });
      if (retrying) yield* reportRecovery();
      const first = yield* Ref.modify(state, (current) => [
        !current.answered,
        { ...current, answered: true },
      ]);
      if (!first) return;
      yield* Effect.logInfo(
        "Codex child got its provider's first answer since the process started",
        { sessionId: session.id, turnId },
      );
      yield* channel.emit(ProviderAnswered.make({ session }));
    });
    const interruptTurn = Effect.fn("CodexRuntime.interruptTurn")(function* () {
      yield* Effect.annotateCurrentSpan({ sessionId: session.id });
      if (yield* lifecycle.isStopping) return;
      const running = yield* Ref.modify(state, (current) =>
        current.turnActive && !current.interrupting
          ? [Option.some(current), { ...current, interrupting: true }]
          : [Option.none<CodexState>(), current],
      );
      if (Option.isNone(running)) return;
      const encodedTurnInterruptParams = yield* Schema.encodeEffect(
        Schema.toCodecJson(TurnInterruptParams),
      )({
        threadId: thread.id,
        turnId: running.value.turnId,
      }).pipe(Effect.orDie);
      yield* running.value.connection
        .request("interrupt", "turn/interrupt", encodedTurnInterruptParams)
        .pipe(
          Effect.onError(() =>
            Ref.update(state, (current) => ({ ...current, interrupting: false })),
          ),
        );
    });
    const submit: (
      message: string,
      id?: OperatorMessageId,
    ) => Effect.Effect<MessageTaken, AgentSessionError> = Effect.fn("CodexRuntime.submit")(
      function* (message, id) {
        yield* Effect.annotateCurrentSpan({ sessionId: session.id });
        const current = yield* Ref.get(state);
        if (current.interrupting) {
          yield* Ref.update(state, (latest) => ({
            ...latest,
            pending: [...latest.pending, { message, id }],
          }));
          return "queued" as const;
        }
        if (!current.turnActive) {
          const messages = yield* Ref.modify(state, (latest) => [
            [...latest.pending, { message, id }],
            { ...latest, pending: [] },
          ]);
          for (const input of messages) {
            const { turnActive } = yield* Ref.get(state);
            if (!turnActive) yield* startTurn(input.message, input.id);
            else yield* submit(input.message, input.id);
          }
          return "queued" as const;
        }
        // Codex records steered input as a user message once the running turn reads it.
        const encodedTurnSteerParams = yield* Schema.encodeEffect(
          Schema.toCodecJson(TurnSteerParams),
        )({
          threadId: thread.id,
          expectedTurnId: current.turnId,
          input: [{ type: "text", text: message, text_elements: [] }],
        }).pipe(Effect.orDie);
        const input: TurnInput = { message, id };
        yield* Ref.update(state, (latest) => ({
          ...latest,
          submitted: [...latest.submitted, input],
        }));
        yield* current.connection
          .request("steer", "turn/steer", encodedTurnSteerParams)
          .pipe(Effect.onError(() => forgetInput(input)));
        return "queued" as const;
      },
    );
    // A turn is active only once `turn/start` answers, so a concurrent input waits for that answer.
    const inputs = yield* Semaphore.make(1);
    const steer = (message: string, id?: OperatorMessageId) =>
      inputs.withPermits(1)(submit(message, id));
    const conversation = yield* sessionConversation({
      session,
      channel,
      policy,
      submitted: Option.isSome(thread.activeTurn) ? policy.restored.unread.map(({ id }) => id) : [],
      items,
      decode: codexReceipts,
      send: (message, _activity, id) => steer(message, id),
      pause: Effect.flatMap(Ref.get(state), ({ toolsInFlight }) =>
        toolsInFlight.size === 0 ? interruptTurn() : Effect.void,
      ),
      beforeFinish: Effect.flatMap(Ref.get(state), ({ connection }) => connection.close),
    });

    /** Acknowledges the unread messages that the restored thread's last turn records. */
    const readLastTurn = (lastTurn: Option.Option<RestoredTurn>) =>
      Option.match(lastTurn, {
        onNone: () => Effect.void,
        onSome: (turn) =>
          Ref.modify(state, (current) => [
            current.receiptsKnown,
            { ...current, receiptsKnown: true },
          ]).pipe(Effect.flatMap((known) => readRestored(session.id, turn, known, conversation))),
      });

    const recoverInput = (message: string, id?: OperatorMessageId) =>
      steer(message, id).pipe(
        Effect.tap(() =>
          Effect.all([conversation.isPaused, Ref.get(state)]).pipe(
            Effect.flatMap(([paused, { toolsInFlight }]) =>
              paused && toolsInFlight.size === 0 ? interruptTurn() : Effect.void,
            ),
          ),
        ),
      );

    const fail = Effect.fn("CodexRuntime.fail")(function* (error: AgentSessionError) {
      if (yield* lifecycle.isStopping) return;
      const { connection } = yield* Ref.get(state);
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
        !isRemoteHost(spec.host) ||
        error._tag !== "SessionOperationError" ||
        !Schema.is(ChildProcessLost)(error.cause)
      )
        return yield* error;
      yield* Effect.logWarning("Remote Codex app-server stopped; resuming its saved thread", {
        sessionId: session.id,
        threadId: thread.id,
      });
      // The lost process no longer waits for its calls; the resumed thread sends them again.
      yield* tools.cancelAll;
      const restored = yield* policy.reopen(
        Effect.gen(function* () {
          const connection = yield* appServer.open({
            ...client,
            sessionId: Option.some(session.id),
            transport: "replace",
          });
          yield* Ref.update(state, (current) => ({ ...current, connection, answered: false }));
          yield* initializeCodex(connection, initialization);
          const billing = yield* codexChildAccount(
            connection,
            spec.session.brain,
            spec.admitted.pool,
          );
          yield* Ref.update(state, (current) => ({ ...current, billing }));
          return yield* resumeThread(connection, client, spec, harnessSession);
        }),
      );
      const { toolsInFlight } = yield* Ref.getAndUpdate(state, (current) => ({
        ...current,
        toolsInFlight: new Map(),
        pending: [],
        submitted: [],
        turnActive: false,
        interrupting: false,
      }));
      const interruptedTools = [...toolsInFlight].map(([callId, tool]) => ({ callId, tool }));
      yield* readLastTurn(restored.lastTurn);
      yield* conversation.recover(interruptedTools, recoverInput, restored.empty);
    });
    const opened = yield* Ref.get(state);
    if (opened.turnActive) {
      yield* Effect.logInfo("Reattached the active Codex turn", {
        sessionId: session.id,
        turnId: opened.turnId,
      });
      if (policy.restored.paused && opened.toolsInFlight.size === 0) yield* interruptTurn();
    } else if (
      !policy.restored.paused &&
      Option.isNone(policy.restored.idle) &&
      Option.isSome(prompt)
    )
      yield* startTurn(prompt.value).pipe(Effect.catch(resume));
    const consumeNotifications = Stream.unwrap(
      Effect.map(Ref.get(state), ({ connection }) => connection.notifications),
    ).pipe(
      Stream.runForEach(({ method, params }) =>
        Effect.gen(function* () {
          if (method === "error") {
            const retry = decodeRetry(params);
            if (Option.isSome(retry) && retry.value.willRetry)
              return yield* reportRetry(retry.value);
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
              const message = yield* decodeItem(UserMessageItem, "user message", session.id, item);
              if (Option.isNone(message)) return;
              return yield* conversation.observe({
                _tag: "Recorded",
                item: message.value,
                turn: notification.value.turnId,
              });
            }
            if (notification.value.turnId !== (yield* Ref.get(state)).turnId) {
              return yield* Effect.logDebug("Skipping a Codex item from another turn", {
                sessionId: session.id,
                turnId: notification.value.turnId,
              });
            }
            if (Schema.is(ModelKindItem)(item)) yield* reportModelOutput();
            const tool = yield* decodeNotifiedToolItem(session.id, item);
            if (Option.isNone(tool)) return;
            yield* Ref.update(state, (current) => ({
              ...current,
              toolsInFlight: new Map(current.toolsInFlight).set(
                tool.value.id,
                tools.toolName(tool.value),
              ),
            }));
            return yield* channel.emit(
              ToolStarted.make({
                session,
                callId: tool.value.id,
                tool: tools.toolName(tool.value),
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
            if (notification.value.turnId !== (yield* Ref.get(state)).turnId) {
              return yield* Effect.logDebug("Skipping a Codex item from another turn", {
                sessionId: session.id,
                turnId: notification.value.turnId,
              });
            }
            const item = notification.value.item;
            if (Schema.is(ModelKindItem)(item)) yield* reportModelOutput();
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
              const final = isMessagePhase(message.value.phase, "final_answer");
              yield* Ref.update(state, (current) => ({
                ...current,
                lastText: Option.some(text),
                finalText: final ? Option.some(text) : current.finalText,
              }));
              return yield* channel.emit(TextOutput.make({ session, text }));
            }
            const tool = yield* decodeNotifiedToolItem(session.id, item);
            if (Option.isNone(tool)) return;
            // Codex completes the item of a call that it cancelled without waiting for the answer.
            yield* tools.cancel(tool.value.id);
            yield* Ref.update(state, (current) => {
              const toolsInFlight = new Map(current.toolsInFlight);
              toolsInFlight.delete(tool.value.id);
              return { ...current, toolsInFlight };
            });
            yield* channel.emit(
              ToolFinished.make({
                session,
                callId: tool.value.id,
                tool: tools.toolName(tool.value),
                output: item,
                isError:
                  isToolStatus(tool.value.status, "failed") ||
                  isApprovalToolStatus(tool.value.status, "declined") ||
                  tool.value.success === false,
              }),
            );
            const { toolsInFlight } = yield* Ref.get(state);
            if (toolsInFlight.size === 0 && (yield* conversation.isPaused)) yield* interruptTurn();
            return;
          }
          if (method === "account/updated") {
            if (Option.isSome(gatewayCredential(spec.admitted.context.credential)))
              return yield* Effect.logInfo(
                "Skipping a Codex account change: the Gateway holds the OpenAI credential",
                { sessionId: session.id },
              );
            const account = yield* Schema.decodeUnknownEffect(AccountUpdated)(params).pipe(
              Effect.mapError(() => codexPoolUnavailable(spec.session.brain.model)),
            );
            const { billing, connection } = yield* Ref.get(state);
            if (
              !isAuthMode(account.authMode, billing.pool === "apiKeys" ? "apikey" : "chatgpt") &&
              !(billing.pool === "chatgptPlan" && isAuthMode(account.authMode, "chatgptAuthTokens"))
            ) {
              yield* Effect.logError("Codex authentication changed during the session", {
                sessionId: session.id,
                authentication: account.authMode ?? "logged-out",
                requiredPool: billing.pool,
              });
              return yield* codexPoolUnavailable(spec.session.brain.model);
            }
            const verified = yield* verifyCodexAccount(connection, spec.session.brain.model);
            yield* Ref.update(state, (current) => ({ ...current, billing: verified }));
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
            const latest = rateLimitsSnapshot(notification.value.rateLimits);
            const { billing } = yield* Ref.updateAndGet(state, (current) => ({
              ...current,
              rateLimits: Option.some(latest),
            }));
            return yield* channel.emit(
              PoolRateLimitsUpdated.make({
                session,
                pool: billing.pool,
                login: billing.login,
                rateLimits: latest,
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
            const { turnId } = yield* Ref.get(state);
            if (completed.turn.id !== turnId) {
              return yield* Effect.logDebug("Skipping another turn's completion", {
                sessionId: session.id,
                turnId: completed.turn.id,
              });
            }
            if (isTurnStatus(completed.turn.status, "completed")) yield* reportModelOutput();
            const { interrupting: wasInterrupted } = yield* Ref.getAndUpdate(state, (current) => ({
              ...current,
              turnActive: false,
              interrupting: false,
            }));
            yield* tools.cancelAll;
            const notRead = new Set((yield* conversation.unread).map(({ id }) => id));
            const { hasNewGuidance, unread } = yield* Ref.modify(state, (current) => {
              const unread = current.submitted.filter(
                (input) => input.id !== undefined && notRead.has(input.id),
              );
              return [
                { hasNewGuidance: current.pending.length > 0, unread },
                {
                  ...current,
                  toolsInFlight: new Map(),
                  submitted: [],
                  pending: [...unread, ...current.pending],
                },
              ];
            });
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
                const nextMessage = yield* Ref.modify(state, (current) => [
                  Arr.last(current.pending),
                  { ...current, pending: current.pending.slice(0, -1) },
                ]);
                if (Option.isSome(nextMessage))
                  yield* steer(nextMessage.value.message, nextMessage.value.id);
                return;
              }
              const { finalText, lastText } = yield* Ref.get(state);
              return yield* conversation.finish(
                Option.getOrElse(
                  Option.orElse(finalText, () => lastText),
                  () => "Codex turn paused",
                ),
              );
            }
            const detail =
              completed.turn.error?.message ??
              (isTurnStatus(completed.turn.status, "interrupted")
                ? "Codex child session was interrupted"
                : "Codex child session failed");
            const { rateLimits } = yield* Ref.get(state);
            const failure = yield* failedTurn(session.id, completed.turn, detail, rateLimits);
            return yield* fail(failure);
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
    // Replayed notifications must not save these receipts before restored guidance is matched.
    if (Option.isNone(thread.activeTurn)) yield* readLastTurn(thread.lastTurn);
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
    const { turnActive } = yield* Ref.get(state);
    return {
      running,
      active: turnActive,
      recover: (tools: ReadonlyArray<InterruptedTool>) =>
        conversation.recover(tools, recoverInput, thread.empty),
    };
  });
  const stop = Effect.fn("CodexRuntime.stop")((spec: SessionSpec) =>
    appServer.stop({
      ...spec,
      protocolFrameMib: Option.getOrUndefined(spec.protocolFrameMib),
      sessionId: Option.some(spec.session.id),
    }),
  );
  return {
    open: openWithTools(open),
    stop,
    complete: structuredCompletion(codexCompletion(appServer)),
  } satisfies Pick<HarnessRuntime, "open" | "stop" | "complete">;
});

/** Provides `ChildBackend` for local or remote children. Requires `CodexAppServer`; validates the model and authentication before starting the task. */
export const codexChildLayer = Layer.effect(
  ChildBackend,
  Effect.map(makeCodexSessions, (sessions) =>
    childContinuation(HarnessCatalog.make({ descriptors: [codex] }), sessions),
  ),
);

export { codexConfigArgs } from "./app-server.ts";

/** Combines preflight and scoped sessions for registration. */
export const codexRuntime = Effect.gen(function* () {
  const sessions = yield* makeCodexSessions;
  const preflight = yield* codexPreflight;
  return { id: codex.id, preflight, ...sessions } satisfies HarnessRuntime;
});

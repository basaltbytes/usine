import type { OperatorMessageId } from "@usine/core/attempt/channel";
import {
  childContinuation,
  checkContinuation,
  checkContinuationHome,
  environmentHome,
} from "../continuation.ts";
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
  PoolRateLimitsUpdated,
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
import { Array as Arr, Deferred, Effect, Layer, Option, Schema, Semaphore, Stream } from "effect";
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
  failedTurn,
  DIAGNOSTIC_METHODS,
  decodeRetry,
  rateLimitsSnapshot,
  UserMessageKindItem,
} from "./codec.ts";
import {
  type AgentSessionError,
  ChildBackend,
  type InterruptedTool,
  ChildSessionLifecycle,
  ChildSessionJournal,
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
import {
  codexChildAccount,
  codexPoolUnavailable,
  initializeCodex,
  verifyCodexAccount,
} from "./account.ts";

export { CodexAppServer, codexAppServerLive, type CodexConnection } from "./app-server.ts";

const isTurnActivity = Schema.is(TurnActivity);

type RestoredTurn = (typeof ThreadResumeResponse.Type.thread.turns)[number];

const resumeThread = Effect.fn("CodexRuntime.resumeThread")(function* (
  connection: CodexConnection,
  client: CodexClient,
  spec: SessionSpec,
  saved: HarnessSession,
) {
  const params: ThreadResumeParams = {
    threadId: saved.id,
    model: spec.session.brain.model,
    cwd: spec.cwd,
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
      spec,
      "model_provider",
      saved.modelProvider,
      Option.some(restored.modelProvider),
    );
  yield* Effect.logInfo("Resumed the saved Codex thread", {
    sessionId: spec.session.id,
    threadId: saved.id,
  });
  return {
    id: saved.id,
    empty: restored.thread.turns.length === 0,
    model: spec.session.brain.model,
    endpoint: Option.some(restored.modelProvider),
    activeTurn: Option.fromUndefinedOr(
      restored.thread.turns.find((turn) => isTurnStatus(turn.status, "inProgress")),
    ),
    lastTurn: Option.fromUndefinedOr(restored.thread.turns.at(-1)),
  };
});

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
    let client: CodexClient = {
      cwd: spec.cwd,
      sessionId: Option.some(spec.session.id),
      environment: spec.environment,
      host: spec.host,
      serve: tools.serve,
    };
    if (start._tag === "StartResume") client = { ...client, transport: "resume" };
    let connection = yield* appServer.open(client);
    yield* checkContinuationHome(spec, start, home, defaultHome);
    yield* initializeCodex(connection, initialization);
    let billing = yield* codexChildAccount(connection, spec.session.brain, spec.admitted.pool);

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
    const journal = yield* ChildSessionJournal.current;
    yield* journal.started(harnessSession);
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
        .map((item): [string, string] => [item.id, tools.toolName(item)]),
    );
    const pendingMessages: Array<{ message: string; id: OperatorMessageId | undefined }> = [];
    const submitted: Array<{
      message: string;
      id: OperatorMessageId | undefined;
      turnId: string | undefined;
    }> = turnActive ? policy.restored.unread.map((message) => ({ ...message, turnId })) : [];
    const forgetInput = (input: (typeof submitted)[number]) =>
      Effect.sync(() => {
        const index = submitted.indexOf(input);
        if (index >= 0) submitted.splice(index, 1);
      });
    // The user-message items observed before a restart already acknowledged their input.
    const observedItems = new Set<string>(Option.getOrElse(policy.restored.receipts, () => []));
    /** The observed user-message items of the last turn, which `journal.received` saves. */
    let receipts = {
      turnId: Option.map(thread.lastTurn, (turn) => turn.id),
      items: [...observedItems],
    };
    let receiptsKnown = start._tag !== "StartResume" || Option.isSome(policy.restored.receipts);
    if (!receiptsKnown && Option.isSome(thread.activeTurn)) {
      const turn = thread.activeTurn.value;
      const messages = yield* Effect.forEach(
        turn.items.filter(Schema.is(UserMessageKindItem)),
        (item) => decodeItem(UserMessageItem, "user message", session.id, item),
      ).pipe(Effect.map(Arr.getSomes));
      // Include these in the next save, but let their replayed notifications acknowledge inputs.
      receipts = { turnId: Option.some(turn.id), items: messages.map(({ id }) => id) };
      yield* Effect.logInfo("Preserving the active Codex turn's existing receipt IDs", {
        sessionId: session.id,
        turnId: turn.id,
        items: receipts.items.length,
      });
    }
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
    // The account's latest rate-limit snapshot, which dates a usage limit's reset.
    let rateLimits = Option.none<RateLimitsSnapshot>();
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
    const submit: (
      message: string,
      id?: OperatorMessageId,
    ) => Effect.Effect<MessageTaken, AgentSessionError> = Effect.fn("CodexRuntime.submit")(
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
            else yield* submit(input.message, input.id);
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
    // A turn is active only once `turn/start` answers, so a concurrent input waits for that answer.
    const inputs = yield* Semaphore.make(1);
    const steer = (message: string, id?: OperatorMessageId) =>
      inputs.withPermits(1)(submit(message, id));
    const conversation = yield* sessionConversation({
      session,
      channel,
      held: policy.restored.held,
      paused: policy.restored.paused,
      idle: policy.restored.idle,
      idleAnsweredOperator: policy.restored.idleAnsweredOperator,
      unread: policy.restored.unread,
      submitted: submitted.flatMap(({ id }) => (id === undefined ? [] : [id])),
      send: (message, _activity, id) => steer(message, id),
      pause: Effect.suspend(() => (toolsInFlight.size === 0 ? interruptTurn() : Effect.void)),
      beforeFinish: Effect.suspend(() => connection.close),
    });

    /** Acknowledges the input of `inputs` that a user message item of `turn` records, once per item. */
    const receive = Effect.fn("CodexRuntime.receive")(function* (
      item: Schema.Json & { readonly type: string },
      turn: string,
      inputs: Array<(typeof submitted)[number]>,
      at: "now" | "restored",
    ) {
      const message = yield* decodeItem(UserMessageItem, "user message", session.id, item);
      if (Option.isNone(message)) return;
      if (observedItems.has(message.value.id))
        return yield* Effect.logInfo("Skipping an observed Codex user-message item", {
          sessionId: session.id,
          turnId: turn,
          itemId: message.value.id,
        });
      observedItems.add(message.value.id);
      receipts = {
        turnId: Option.some(turn),
        items: [
          ...new Set([
            ...(Option.contains(receipts.turnId, turn) ? receipts.items : []),
            message.value.id,
          ]),
        ],
      };
      // Saved before the read, so a restart never matches this item to another unread message.
      yield* journal.received(receipts.items);
      const text = userMessageText(message.value);
      const index = inputs.findIndex(
        (input) => (input.turnId === undefined || input.turnId === turn) && input.message === text,
      );
      if (index < 0) return;
      const [input] = inputs.splice(index, 1);
      if (input?.id !== undefined) yield* conversation.read([input.id], at);
    });
    /**
     * Acknowledges the unread messages that the restored thread's last turn records, so recovery
     * doesn't send them again.
     */
    const readRestored = Effect.fn("CodexRuntime.readRestored")(function* (
      lastTurn: Option.Option<RestoredTurn>,
    ) {
      if (Option.isNone(lastTurn)) return;
      const turn = lastTurn.value;
      if (!receiptsKnown) {
        const messages = yield* Effect.forEach(
          turn.items.filter(Schema.is(UserMessageKindItem)),
          (item) => decodeItem(UserMessageItem, "user message", session.id, item),
        ).pipe(Effect.map(Arr.getSomes));
        receipts = { turnId: Option.some(turn.id), items: messages.map(({ id }) => id) };
        yield* journal.received(receipts.items);
        for (const id of receipts.items) observedItems.add(id);
        receiptsKnown = true;
        return yield* Effect.logInfo(
          "Skipping restored Codex matching without saved receipt history",
          {
            sessionId: session.id,
            turnId: turn.id,
            observed: receipts.items.length,
            unread: (yield* conversation.unread).length,
          },
        );
      }
      const unread = (yield* conversation.unread).map((message) => ({
        ...message,
        turnId: turn.id,
      }));
      const count = unread.length;
      let skipped = 0;
      for (const item of turn.items) {
        if (!Schema.is(UserMessageKindItem)(item)) continue;
        if (Schema.is(UserMessageItem)(item) && observedItems.has(item.id)) skipped++;
        yield* receive(item, turn.id, unread, "restored");
      }
      const read = count - unread.length;
      if (count > 0)
        yield* Effect.logInfo("Checked restored Codex user-message receipts", {
          sessionId: session.id,
          turnId: turn.id,
          skipped,
          read,
          unread: unread.length,
        });
    });

    const recoverInput = (message: string, id?: OperatorMessageId) =>
      steer(message, id).pipe(
        Effect.tap(() =>
          conversation.isPaused.pipe(
            Effect.flatMap((paused) =>
              paused && toolsInFlight.size === 0 ? interruptTurn() : Effect.void,
            ),
          ),
        ),
      );

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
          connection = yield* appServer.open({
            ...client,
            sessionId: Option.some(session.id),
            transport: "replace",
          });
          yield* initializeCodex(connection, initialization);
          billing = yield* codexChildAccount(connection, spec.session.brain, spec.admitted.pool);
          return yield* resumeThread(connection, client, spec, harnessSession);
        }),
      );
      const interruptedTools = [...toolsInFlight].map(([callId, tool]) => ({ callId, tool }));
      toolsInFlight.clear();
      pendingMessages.length = 0;
      submitted.length = 0;
      turnActive = false;
      interrupting = false;
      yield* readRestored(restored.lastTurn);
      yield* conversation.recover(policy, interruptedTools, recoverInput, restored.empty);
    });
    if (turnActive) {
      yield* Effect.logInfo("Reattached the active Codex turn", {
        sessionId: session.id,
        turnId,
      });
      if (policy.restored.paused && toolsInFlight.size === 0) yield* interruptTurn();
    } else if (
      !policy.restored.paused &&
      Option.isNone(policy.restored.idle) &&
      Option.isSome(prompt)
    )
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
            if (Schema.is(UserMessageKindItem)(item))
              return yield* receive(item, notification.value.turnId, submitted, "now");
            if (notification.value.turnId !== turnId) {
              return yield* Effect.logDebug("Skipping a Codex item from another turn", {
                sessionId: session.id,
                turnId: notification.value.turnId,
              });
            }
            const tool = yield* decodeNotifiedToolItem(session.id, item);
            if (Option.isNone(tool)) return;
            toolsInFlight.set(tool.value.id, tools.toolName(tool.value));
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
            // Codex completes the item of a call that it cancelled without waiting for the answer.
            yield* tools.cancel(tool.value.id);
            toolsInFlight.delete(tool.value.id);
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
            billing = yield* verifyCodexAccount(connection, spec.session.brain.model);
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
            rateLimits = Option.some(latest);
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
            yield* tools.cancelAll;
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
    if (!turnActive) yield* readRestored(thread.lastTurn);
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
        conversation.recover(policy, tools, recoverInput, thread.empty),
    };
  });
  const stop = Effect.fn("CodexRuntime.stop")((spec: SessionSpec) =>
    appServer.stop({ ...spec, sessionId: Option.some(spec.session.id) }),
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

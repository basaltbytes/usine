import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import {
  type RateLimitsSnapshot,
  SessionTokensUpdated,
  TokenCount,
} from "@usine/core/agent/session";
import { Effect, Option, Schema, Stream } from "effect";
import {
  AgentMessageItem,
  CodexTokenUsage,
  ItemNotification,
  isMessagePhase,
  isTurnStatus,
  RateLimitsUpdated,
  ThreadStartParams,
  ThreadStartResponse,
  TurnCompleted,
  TurnStartParams,
  TurnStartResponse,
} from "../../protocol/codex/codex.ts";
import { parentFields, resolvedSession } from "../adapter.ts";
import { CompletionReply, type CompletionRequest } from "../completion.ts";
import { codexChildAccount, initializeCodex } from "./account.ts";
import {
  type CodexAppServer,
  type CodexClient,
  type CodexNotification,
  operationError,
} from "./app-server.ts";
import {
  AgentMessageKindItem,
  DIAGNOSTIC_METHODS,
  decodeItem,
  decodeNotification,
  decodeResponse,
  decodeRetry,
  failedTurn,
  providerRetryMessage,
  rateLimitsSnapshot,
} from "./codec.ts";
import { checkCodexModel } from "./model.ts";
import { codexThreadTokens, codexTokenBreakdown } from "../usage.ts";

/**
 * Runs a structured completion on an app server from `appServer`: an ephemeral, read-only thread
 * whose one turn has the completion's schema as its output schema. Returns the final answer, whose
 * text is the value. Codex reports no refusal, so a declined answer is one that isn't JSON.
 */
export const codexCompletion = (appServer: CodexAppServer["Service"]) =>
  Effect.fn("CodexRuntime.complete")(function* ({
    spec,
    prompt,
    schema,
    spent,
  }: CompletionRequest) {
    yield* Effect.annotateCurrentSpan({
      agent: spec.session.agent,
      effort: spec.session.brain.effort,
      harness: spec.session.brain.harness,
      model: spec.session.brain.model,
      ...parentFields(spec.session),
      sessionId: spec.session.id,
    });
    yield* Effect.logInfo("Starting Codex structured completion");
    const client: CodexClient = {
      cwd: spec.cwd,
      sessionId: Option.some(spec.session.id),
      environment: spec.environment,
      host: spec.host,
    };
    const connection = yield* appServer.open(client);
    yield* initializeCodex(connection);
    const billing = yield* codexChildAccount(connection, spec.session.brain, spec.admitted.pool);
    const effort = yield* checkCodexModel(connection, client, spec);
    // An ephemeral thread writes no rollout, so nothing can resume it. Codex keeps its own tools,
    // so the sandbox is read-only.
    const threadParams: ThreadStartParams = {
      model: spec.session.brain.model,
      allowProviderModelFallback: false,
      cwd: spec.cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      serviceName: "usine",
    };
    const encodedThreadParams = yield* Schema.encodeEffect(Schema.toCodecJson(ThreadStartParams))(
      threadParams,
    ).pipe(Effect.orDie);
    const threadResponse = yield* connection.request("launch", "thread/start", encodedThreadParams);
    const thread = yield* decodeResponse(
      ThreadStartResponse,
      "launch",
      client,
      "thread start response",
      threadResponse,
    );
    const session = resolvedSession(spec.session, {
      brain: BrainSpec.make({
        harness: Harness.make("codex"),
        model: ModelId.make(thread.model),
        effort: spec.session.brain.effort,
      }),
      pool: Option.some(billing.pool),
      endpoint: billing.pool === "apiKeys" ? Option.some(thread.modelProvider) : Option.none(),
    });
    const encodedTurnParams = yield* Schema.encodeEffect(Schema.toCodecJson(TurnStartParams))({
      threadId: thread.thread.id,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      cwd: spec.cwd,
      approvalPolicy: "never",
      effort,
      outputSchema: schema,
    }).pipe(Effect.orDie);
    const turnResponse = yield* connection.request("stream", "turn/start", encodedTurnParams);
    const turn = yield* decodeResponse(
      TurnStartResponse,
      "stream",
      client,
      "turn start response",
      turnResponse,
    );
    yield* spent(SessionTokensUpdated.make({ session, totalTokens: TokenCount.make(0) }));
    let lastText = Option.none<string>();
    let finalText = Option.none<string>();
    let completion = Option.none<typeof TurnCompleted.Type>();
    // The account's latest rate-limit snapshot, which dates a usage limit's reset.
    let rateLimits = Option.none<RateLimitsSnapshot>();
    const isTurnCompletion = (notification: CodexNotification) =>
      notification.method === "turn/completed" &&
      Schema.is(Schema.Struct({ turn: Schema.Struct({ id: Schema.Literal(turn.turn.id) }) }))(
        notification.params,
      );
    yield* connection.notifications.pipe(
      Stream.takeUntil(isTurnCompletion),
      Stream.runForEach(({ method, params }) =>
        Effect.gen(function* () {
          if (method === "thread/tokenUsage/updated") {
            const tokens = yield* decodeNotification(
              CodexTokenUsage,
              "token usage",
              session.id,
              params,
            );
            if (Option.isSome(tokens) && tokens.value.threadId === thread.thread.id) {
              const total = tokens.value.tokenUsage.total;
              yield* spent(
                SessionTokensUpdated.make({
                  session,
                  totalTokens: codexThreadTokens(total),
                  breakdown: Option.some(codexTokenBreakdown(total)),
                }),
              );
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
            if (Option.isSome(notification))
              rateLimits = Option.some(rateLimitsSnapshot(notification.value.rateLimits));
            return;
          }
          if (method === "item/completed") {
            const notification = yield* decodeNotification(
              ItemNotification,
              "item notification",
              session.id,
              params,
            );
            if (Option.isNone(notification) || notification.value.turnId !== turn.turn.id) return;
            const item = notification.value.item;
            if (!Schema.is(AgentMessageKindItem)(item)) return;
            const message = yield* decodeItem(AgentMessageItem, "agent message", session.id, item);
            if (Option.isNone(message) || message.value.text.trim().length === 0) return;
            lastText = Option.some(message.value.text.trim());
            if (isMessagePhase(message.value.phase, "final_answer")) finalText = lastText;
            return;
          }
          if (method === "turn/completed") {
            const completed = yield* decodeResponse(
              TurnCompleted,
              "stream",
              client,
              "turn completion",
              params,
            );
            completion = Option.some(completed);
            return;
          }
          if (method === "error") {
            const retry = decodeRetry(params);
            if (Option.isSome(retry) && retry.value.willRetry)
              return yield* Effect.logWarning(
                "Codex completion cannot reach its provider and will retry",
                { sessionId: session.id, message: providerRetryMessage(retry.value.error) },
              );
          }
          if (DIAGNOSTIC_METHODS.has(method))
            return yield* Effect.logWarning("Codex reported a diagnostic", {
              method,
              params,
              sessionId: session.id,
            });
        }),
      ),
    );
    yield* connection.close;
    if (Option.isNone(completion))
      return yield* operationError(
        "stream",
        client,
        "Codex notification stream closed without a completion",
        new Error("unexpected end of notifications"),
      );
    const finished = completion.value.turn;
    if (!isTurnStatus(finished.status, "completed"))
      return yield* yield* failedTurn(
        session.id,
        finished,
        finished.error?.message ?? "Codex completion turn failed",
        rateLimits,
      );
    const text = Option.orElse(finalText, () => lastText);
    return Option.match(text, {
      onNone: () =>
        CompletionReply.Missing({
          message: "Codex finished the completion without a final answer",
        }),
      onSome: (answer) => CompletionReply.Answer({ text: answer }),
    });
  });

import { AgentName } from "@usine/core/agent";
import { Harness, BrainSpec, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  BackgroundWork,
  ChildSession,
  type OperatorMessageId,
  ParentSession,
  ToolFinished,
  ToolStarted,
} from "@usine/core/agent/session";
import { Deferred, Effect, Logger, Option, Queue } from "effect";
import { ChildSessionJournal, type OnDelivery, RestartState } from "../../../src/runtime.ts";
import { sessionChannel } from "../../../src/harness/session.ts";
import { sessionConversation } from "../../../src/harness/conversation.ts";
import { type ReadPoint, Receipt } from "../../../src/harness/receipts.ts";
import type { ContinuationPolicy } from "../../../src/harness/continuation.ts";

const parent = ParentSession.make({
  id: AgentSessionId.make("parent"),
  agent: AgentName.make("developer"),
  brain: BrainSpec.make({
    harness: Harness.make("pi"),
    model: ModelId.make("openai/model"),
    effort: "medium",
  }),
});
export const child = (id: string) =>
  ChildSession.make({
    id: AgentSessionId.make(id),
    parentId: parent.id,
    agent: parent.agent,
    brain: parent.brain,
  });
/** A continuation policy over `restored` that saves nothing; recovery sends a continuation. */
export const policyOf = (restored: RestartState): ContinuationPolicy => ({
  restored,
  journal: ChildSessionJournal.noop,
  reopen: (native) => native,
  recover: (_state, _tools, _unread, _emit, send) => send("Continue the task."),
});

/**
 * The signal of the test harness: the operator messages that the session read, and where. Its
 * decoder is all that the test adapter supplies for reads.
 */
interface TestRead {
  readonly ids: ReadonlyArray<OperatorMessageId>;
  readonly at: ReadPoint;
}
export const testReceipts = ({ ids, at }: TestRead) => [
  Receipt.ById({ ids, at, opensTurn: false }),
];

export const conversation = (
  session: ChildSession,
  restored: {
    readonly held?: boolean;
    readonly idle?: Option.Option<string>;
    readonly idleAnsweredOperator?: boolean;
  } = {},
  maxBackgroundWaitMinutes: Option.Option<number> = Option.none(),
) =>
  Effect.gen(function* () {
    const channel = yield* sessionChannel({ sessionId: session.id, label: "Conversation test" });
    const turns: Array<{ message: string; activity: "idle" | "running" }> = [];
    const controls = yield* sessionConversation({
      session,
      channel,
      policy: policyOf(
        RestartState.make({
          held: restored.held ?? false,
          idle: restored.idle ?? Option.none(),
          idleAnsweredOperator: restored.idleAnsweredOperator ?? false,
        }),
      ),
      decode: testReceipts,
      // A message to a running turn waits for the harness's next boundary.
      send: (message, activity) =>
        Effect.sync(() => {
          turns.push({ message, activity });
          return activity === "idle" ? ("read" as const) : ("queued" as const);
        }),
      pause: Effect.void,
      beforeFinish: Effect.void,
      maxBackgroundWaitMinutes,
    });
    const result = yield* Deferred.await(channel.result).pipe(Effect.forkChild);
    /** Returns the tags of the events the session emitted since the last call. */
    const emitted = Queue.clear(channel.events).pipe(
      Effect.map((events) => events.map((event) => event._tag)),
    );
    /** Returns the events the session emitted since the last call. */
    const events = Queue.clear(channel.events);
    /** Emits a started tool call, as the harness does when the session runs a tool. */
    const runTool = (callId: string) =>
      channel.emit(ToolStarted.make({ session, callId, tool: "bash", input: null }));
    /** Emits a tool call's result, as the harness does when the tool returns. */
    const finishTool = (callId: string) =>
      channel.emit(
        ToolFinished.make({ session, callId, tool: "bash", output: "ok", isError: false }),
      );
    /** Runs a tool call to its result. */
    const runToolRound = (callId: string) =>
      runTool(callId).pipe(Effect.andThen(finishTool(callId)));
    /** Queues a started tool call from a vendor callback, as Pi does. */
    const runToolUnsafe = (callId: string) =>
      Effect.sync(() =>
        channel.emitUnsafe(ToolStarted.make({ session, callId, tool: "bash", input: null })),
      );
    /** Signals that the session read `ids` at `at`. */
    const read = (ids: ReadonlyArray<OperatorMessageId>, at: ReadPoint = "now") =>
      controls.observe({ ids, at });
    return {
      ...controls,
      read,
      result,
      turns,
      emitted,
      events,
      runTool,
      finishTool,
      runToolRound,
      runToolUnsafe,
      toolCalls: channel.toolCalls,
    };
  });

export const noDelivery: OnDelivery = () => Effect.void;

export const ciWatch = BackgroundWork.make({
  id: "ci-watch",
  kind: "command",
  description: "Watch CI",
});

export const capturedLogs = () => {
  const entries: Array<Pick<Logger.Options<unknown>, "logLevel" | "message">> = [];
  const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
    entries.push({ logLevel, message });
  });
  return { entries, layer: Logger.layer([logger]) };
};

/** The number of captured log messages that contain `text`. */
export const loggedTimes = (logs: ReturnType<typeof capturedLogs>, text: string) =>
  logs.entries.filter(({ message }) => Array.isArray(message) && String(message[0]).includes(text))
    .length;

/** Whether a captured log message contains `text`. */
export const logged = (logs: ReturnType<typeof capturedLogs>, text: string) =>
  loggedTimes(logs, text) > 0;

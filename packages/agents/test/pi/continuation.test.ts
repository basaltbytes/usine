import { assert, describe, it } from "@effect/vitest";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  ChildSession,
  HarnessSession,
  type AgentSessionEvent,
} from "@usine/core/agent/session";
import { OperatorMessageId } from "@usine/core/attempt/channel";
import { WorkerName } from "@usine/core/worker";
import { Deferred, Effect, Option, Result, Stream } from "effect";
import { LocalProcess } from "../../src/child-host/child-host.ts";
import {
  childContinuation,
  continuationPlan,
  CONTINUATION_MESSAGE,
} from "../../src/harness/continuation.ts";
import { sessionConversation } from "../../src/harness/conversation.ts";
import { sessionChannel } from "../../src/harness/session.ts";
import {
  ChildRequest,
  ChildSessionJournal,
  SessionOperationError,
  WorkingDirectory,
} from "../../src/runtime.ts";

const session = ChildSession.make({
  id: AgentSessionId.make("child"),
  parentId: AgentSessionId.make("parent"),
  agent: AgentName.make("developer"),
  brain: BrainSpec.make({
    harness: Harness.make("claude"),
    model: ModelId.make("model"),
    effort: "off",
  }),
});
const reference = HarnessSession.make({ cwd: "/checkout" });
const request = ChildRequest.make({
  session,
  cwd: WorkingDirectory.make("/checkout"),
  prompt: "Original task",
  host: LocalProcess.make(),
  worker: WorkerName.make("local"),
  machine: Option.none(),
  environment: {},
  resume: Option.some(reference),
  inFlight: [{ callId: "tool-1", tool: "Bash" }],
  unread: [
    {
      id: OperatorMessageId.make("00000000-0000-4000-8000-000000000001"),
      message: "Check this too",
    },
  ],
});
const working = { held: false, paused: false, idle: false };

describe("shared continuation policy", () => {
  it("refuses the fourth continuation within ten minutes and ages out old entries", () => {
    const fourth = continuationPlan(session, working, [1, 2, 3], 4);
    assert(Result.isFailure(fourth));
    assert.strictEqual(fourth.failure._tag, "ContinuationLimitError");
    assert.deepStrictEqual(
      continuationPlan(session, working, [1, 2, 3], 600_003),
      Result.succeed({ continue: true, history: [600_003] }),
    );
    for (const field of ["held", "paused", "idle"] as const)
      assert.deepStrictEqual(
        continuationPlan(session, { ...working, [field]: true }, [1, 2, 3], 4),
        Result.succeed({ continue: false, history: [1, 2, 3] }),
      );
  });

  for (const state of [
    "working",
    "empty",
    "held",
    "paused",
    "idle",
    "released",
    "missing",
  ] as const) {
    it.effect(`reopens without a prompt and applies the ${state} recovery decision`, () => {
      const history: Array<ReadonlyArray<number>> = [];
      return Effect.gen(function* () {
        const sent: Array<{ message: string; id?: OperatorMessageId }> = [];
        const events: Array<AgentSessionEvent> = [];
        let opens = 0;
        let closed = 0;
        const adapter = childContinuation({
          stop: () => Effect.void,
          open: (input, prompt, policy) =>
            Effect.gen(function* () {
              opens++;
              assert(Option.isNone(prompt), "native reopening never sends the original task");
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  closed++;
                }),
              );
              if (state === "missing")
                return yield* SessionOperationError.make({
                  operation: "launch",
                  sessionId: Option.some(session.id),
                  message: "Missing native session",
                  cause: "missing",
                });
              const channel = yield* sessionChannel({
                sessionId: session.id,
                label: "Continuation test",
              });
              const steer = (message: string, id?: OperatorMessageId) =>
                Effect.sync(() => {
                  sent.push(id === undefined ? { message } : { message, id });
                });
              const conversation = yield* sessionConversation({
                session,
                channel,
                held: input.held,
                paused: input.paused,
                idle: input.idle,
                unread: input.unread,
                send: (message, _activity, id) =>
                  steer(message, id).pipe(Effect.as("queued" as const)),
                pause: Effect.void,
                beforeFinish: Effect.void,
              });
              const running = {
                session,
                steer,
                intervene: conversation.intervene,
                interrupt: Effect.void,
                events: Stream.fromQueue(channel.events),
                result: Deferred.await(channel.result),
              };
              return {
                running,
                active: false,
                recover: (tools) => conversation.recover(policy, tools, steer, state === "empty"),
              };
            }),
        });
        const input = ChildRequest.make({
          ...request,
          held: state === "held" || state === "idle",
          paused: state === "paused",
          idle:
            state === "idle" || state === "released" ? Option.some("Saved result") : Option.none(),
        });
        if (state === "missing") {
          const absent = yield* adapter.resume(input, reference);
          assert(Option.isNone(absent));
          assert.strictEqual(closed, 1, "failed native reopening closes its resources immediately");
          const failure = yield* adapter.launch(input).pipe(Effect.flip);
          assert.strictEqual(failure._tag, "SessionInterruptedError");
          assert.lengthOf(sent, 0);
        } else {
          const native = yield* adapter.resume(input, reference);
          assert(Option.isSome(native));
          assert.lengthOf(sent, 0, "resume is only a native primitive");
          const running = yield* adapter.launch(input);
          yield* running.events.pipe(
            Stream.take(state === "working" || state === "empty" ? 1 : 2),
            Stream.runForEach((event) =>
              Effect.sync(() => {
                events.push(event);
              }),
            ),
          );
          if (state === "released") {
            assert.strictEqual((yield* running.result).message, "Saved result");
            assert.deepStrictEqual(
              events.map((event) => event._tag),
              ["SessionFinished"],
            );
          } else {
            const tool = events.find((event) => event._tag === "ToolFinished");
            assert(tool?._tag === "ToolFinished" && tool.isError);
            assert.strictEqual(tool.callId, "tool-1");
          }
          assert.deepStrictEqual(
            sent,
            state === "working" || state === "empty"
              ? [
                  { message: state === "empty" ? request.prompt : CONTINUATION_MESSAGE },
                  {
                    message: "Check this too",
                    id: OperatorMessageId.make("00000000-0000-4000-8000-000000000001"),
                  },
                ]
              : [],
          );
          assert.lengthOf(history, state === "working" || state === "empty" ? 1 : 0);
        }
        assert.strictEqual(opens, 2);
      }).pipe(
        Effect.provideService(ChildSessionJournal, {
          started: () => Effect.void,
          prompted: Effect.void,
          continued: (timestamps) =>
            Effect.sync(() => {
              history.push(timestamps);
            }),
          delivered: () => Effect.void,
        }),
        Effect.scoped,
      );
    });
  }
});

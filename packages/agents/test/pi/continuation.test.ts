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
import { Array as Arr, Deferred, Effect, Option, Result, Stream } from "effect";
import { LocalProcess } from "../../src/child-host/child-host.ts";
import {
  childContinuation,
  continuationPlan,
  CONTINUATION_MESSAGE,
} from "../../src/harness/continuation.ts";
import { catalog } from "../../src/harness/catalog.ts";
import { claude } from "../../src/harness/claude/descriptor.ts";
import { CapabilityProfile, Lacking } from "../../src/harness/capability.ts";
import { HarnessCatalog, HarnessDescriptor } from "../../src/harness/harness.ts";
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
const unsaved = SessionOperationError.make({
  operation: "launch",
  sessionId: Option.some(session.id),
  message: "Could not save the child before its first prompt",
  cause: "storage unavailable",
});

describe("shared continuation policy", () => {
  it.effect("refuses to resume when the credential route lacks resume-session", () => {
    const withoutResume = HarnessCatalog.make({
      descriptors: [
        HarnessDescriptor.make({
          ...claude,
          capabilities: Arr.map(claude.capabilities, (profile) =>
            CapabilityProfile.make({
              ...profile,
              supported: profile.supported.filter((capability) => capability !== "resume-session"),
              lacking: [
                ...profile.lacking,
                Lacking.make({ capability: "resume-session", reason: "No saved-session recovery" }),
              ],
            }),
          ),
        }),
      ],
    });
    let opens = 0;
    const adapter = childContinuation(withoutResume, {
      stop: () => Effect.void,
      open: () =>
        Effect.sync(() => {
          opens++;
        }).pipe(Effect.andThen(Effect.die("a refused resume cannot open a session"))),
    });
    return Effect.gen(function* () {
      const error = yield* adapter
        .resume(ChildRequest.make({ ...request, resume: Option.none() }), reference)
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "AgentResultError");
      assert.include(error.message, "resume-session");
      assert.strictEqual(opens, 0);
    }).pipe(
      Effect.provideService(ChildSessionJournal, {
        started: () => Effect.void,
        prompted: Effect.void,
        continued: () => Effect.void,
        delivered: () => Effect.void,
      }),
      Effect.scoped,
    );
  });

  it("refuses the fourth continuation within ten minutes and ages out old entries", () => {
    const fourth = continuationPlan(session, working, [1, 2, 3], 4);
    assert(Result.isFailure(fourth));
    assert.strictEqual(fourth.failure._tag, "ContinuationLimitError");
    assert.deepStrictEqual(
      continuationPlan(session, working, [1, 2, 3], 600_003),
      Result.succeed({ continue: true, history: [600_003] }),
    );
    for (const field of ["held", "paused", "idle"] as const) {
      assert.deepStrictEqual(
        continuationPlan(session, { ...working, [field]: true }, [1, 2, 3], 4),
        Result.succeed({ continue: false, history: [1, 2, 3] }),
      );
      assert.deepStrictEqual(
        continuationPlan(session, { ...working, [field]: true, empty: true }, [], 4),
        Result.succeed({ continue: true, history: [4] }),
        `a child without its task gets it while ${field}`,
      );
    }
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
        const adapter = childContinuation(catalog, {
          stop: () => Effect.void,
          open: (_spec, start, policy) =>
            Effect.gen(function* () {
              opens++;
              assert(
                start._tag === "StartResume",
                "native reopening never sends the original task",
              );
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  closed++;
                }),
              );
              yield* (yield* ChildSessionJournal.current).started(reference);
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
                held: policy.restored.held,
                paused: policy.restored.paused,
                idle: policy.restored.idle,
                idleAnsweredOperator: policy.restored.idleAnsweredOperator,
                unread: policy.restored.unread,
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
                recover: (tools) =>
                  conversation.recover(
                    policy,
                    tools,
                    (message, id) => steer(message, id).pipe(Effect.as("queued" as const)),
                    state === "empty",
                  ),
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
          assert(failure._tag === "SessionInterruptedError");
          assert.deepStrictEqual(failure.cause, Option.some(unsaved));
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
          started: () => (state === "missing" ? Effect.fail(unsaved) : Effect.void),
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

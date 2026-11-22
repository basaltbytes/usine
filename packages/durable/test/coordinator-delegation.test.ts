import { assert, describe, it } from "@effect/vitest";
import {
  ChildSession,
  ChildSessionCount,
  ToolFinished,
  ToolStarted,
} from "@usine/core/agent/session";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { Effect, Option } from "effect";
import { StoredRequest } from "../src/attempt-runtime.ts";
import { childSessionId, parentSessionId } from "../src/attempt/sessions.ts";
import { journalDelegation } from "../src/coordinator/delegation.ts";
import {
  AttemptJournal,
  Delegate,
  Delegation,
  EncodedDecision,
  EncodedEvent,
  EncodedState,
  JournalRevision,
  Transition,
} from "../src/coordinator/journal.ts";
import { memoryAttemptJournalLayer } from "../src/coordinator/memory.ts";
import { outboxFor, startedWithoutParent } from "../src/coordinator/outbox.ts";
import { supervisorFor } from "../src/coordinator/supervision.ts";
import { attemptRequest, recordingSink, trace } from "./support.ts";

describe("journalDelegation", () => {
  it.effect("changes the in-flight calls only with a tool event that the outbox relays", () =>
    Effect.gen(function* () {
      const request = attemptRequest("delegation/tool-events");
      const attemptId = request.spec.attemptId;
      const number = ChildSessionCount.make(1);
      const session = ChildSession.make({
        id: childSessionId(attemptId, 1),
        parentId: parentSessionId(attemptId),
        agent: request.spec.agent.name,
        brain: request.spec.agent.brain,
      });
      const started = (callId: string) =>
        ToolStarted.make({ session, callId, tool: "bash", input: "pnpm test" });
      const finished = (callId: string) =>
        ToolFinished.make({ session, callId, tool: "bash", output: "passed", isError: false });
      const first = recordingSink();
      const second = recordingSink();
      const result = yield* Effect.gen(function* () {
        const journal = yield* AttemptJournal;
        yield* journal.open(
          StoredRequest.make({ spec: request.spec, worker: request.worker, cwd: request.cwd }),
        );
        yield* journal.transition(
          attemptId,
          JournalRevision.make(0),
          Transition.make({
            event: EncodedEvent.make({ _tag: "AttemptStarted" }),
            decision: EncodedDecision.make({ _tag: "Delegate" }),
            state: EncodedState.make({ _tag: "Delegating" }),
            intents: [
              Delegate.make({ delegation: Delegation.make({ number, assignment: Option.none() }) }),
            ],
            outbound: [],
          }),
        );
        yield* journal.startDelegation(attemptId, number);
        const outbox = yield* outboxFor(journal, attemptId);
        const delegation = journalDelegation(
          journal,
          supervisorFor(journal, attemptId),
          outbox,
          attemptId,
          number,
        );
        const loaded = Effect.flatMap(journal.load(attemptId), (snapshot) =>
          Option.match(snapshot, {
            onNone: () => Effect.die(new Error("no journal")),
            onSome: Effect.succeed,
          }),
        );
        const inFlight = Effect.map(loaded, ({ delegations }) =>
          Option.map(
            Option.flatMap(Option.fromUndefinedOr(delegations[0]), ({ progress }) => progress),
            ({ inFlight }) => inFlight,
          ),
        );

        // Before an execute call attaches.
        yield* delegation.toolEvent(started("call-1"));
        const beforeAttach = yield* inFlight;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const snapshot = yield* loaded;
            yield* outbox.attach(first.sink, snapshot);
            yield* outbox.emit([startedWithoutParent(request.spec)]);
            yield* delegation.toolEvent(started("call-2"));
            yield* delegation.toolEvent(started("call-3"));
          }),
        );
        const attached = yield* inFlight;
        // The call detached: the transcript doesn't get the event, and call-2 stays in flight.
        yield* delegation.toolEvent(finished("call-2"));
        const afterDetach = yield* inFlight;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const snapshot = yield* loaded;
            yield* outbox.attach(second.sink, snapshot);
            yield* outbox.emit([AttemptChannel.Interrupted.make({})]);
            // After the terminal envelope.
            yield* delegation.toolEvent(finished("call-3"));
          }),
        );
        const afterEnd = yield* inFlight;
        const { outbox: reserved, nextOutbound } = yield* loaded;
        return { beforeAttach, attached, afterDetach, afterEnd, reserved, nextOutbound };
      }).pipe(Effect.provide(memoryAttemptJournalLayer));

      const open = [
        { callId: "call-2", tool: "bash" },
        { callId: "call-3", tool: "bash" },
      ];
      assert.deepStrictEqual(result.beforeAttach, Option.some([]));
      assert.deepStrictEqual(result.attached, Option.some(open));
      assert.deepStrictEqual(result.afterDetach, Option.some(open));
      assert.deepStrictEqual(result.afterEnd, Option.some(open));
      assert.deepStrictEqual(trace(first.outbound()), [
        "Started",
        "child.ToolStarted:bash",
        "child.ToolStarted:bash",
      ]);
      assert.deepStrictEqual(trace(second.outbound()), ["Interrupted"]);
      assert.deepStrictEqual(result.reserved, []);
      assert.strictEqual(result.nextOutbound, 5);
    }),
  );
});

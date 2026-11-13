import type { AttemptId } from "@usine/core/attempt";
import { Effect, Option, type Scope, Stream, SubscriptionRef } from "effect";

import type { AttemptRequest } from "../attempt-runtime.ts";
import type { AttachedCall, DelegationAttachment } from "../attempt/delegation/journal.ts";

/** Why the attached `execute` call ends for good: a cancel, or a failure of its sink. */
export type Ending = "canceled" | "sink failed";

/** The number that tells one `execute` call of an Attempt from the next. */
type CallNumber = number;

/** No `execute` call relays the Attempt. */
interface Detached {
  readonly _tag: "Detached";
}

/** Call `call` holds the Attempt while its outbox attaches; its children don't run yet. */
interface Attaching {
  readonly _tag: "Attaching";
  readonly call: CallNumber;
  readonly ending: Option.Option<Ending>;
}

/** Call `call` relays the Attempt, and its children run with `request`. */
interface Attached {
  readonly _tag: "Attached";
  readonly call: CallNumber;
  readonly request: AttemptRequest;
  readonly ending: Option.Option<Ending>;
}

/** Call `call` stopped, as on a process stop: its children stop, and it detaches next. */
interface Releasing {
  readonly _tag: "Releasing";
  readonly call: CallNumber;
  readonly ending: Option.Option<Ending>;
}

type State = Detached | Attaching | Attached | Releasing;

const detached: State = { _tag: "Detached" };

/**
 * The `execute` call that relays one Attempt. Each call moves from `Detached` through `Attaching`
 * and `Attached`, and on a process stop through `Releasing`, back to `Detached`; a cancel or a sink
 * failure records why the call ends without changing its state.
 */
export interface Attachment {
  /**
   * Waits until no call relays the Attempt, then holds it for a new call until the scope closes,
   * and returns the call's number.
   */
  readonly hold: Effect.Effect<CallNumber, never, Scope.Scope>;
  /** Lets the children of call `call` run with `request`. */
  readonly publish: (call: CallNumber, request: AttemptRequest) => Effect.Effect<void>;
  /** Stops the attached call's children before the call detaches. Does nothing otherwise. */
  readonly release: Effect.Effect<void>;
  /**
   * Records `ending` for the call that relays the Attempt unless it has one, and returns the call,
   * or `None` while none does.
   */
  readonly end: (ending: Ending) => Effect.Effect<Option.Option<CallNumber>>;
  /** Why the call that relays the Attempt ends, or `None`. */
  readonly ending: Effect.Effect<Option.Option<Ending>>;
  /** Completes when the call that relays the Attempt is canceled. */
  readonly canceled: Effect.Effect<void>;
  /** Waits for an attached call and returns its request. */
  readonly request: Effect.Effect<AttemptRequest>;
  /** Completes once call `call` detached. */
  readonly detached: (call: CallNumber) => Effect.Effect<void>;
  /** Whether no call relays the Attempt. */
  readonly isDetached: Effect.Effect<boolean>;
  /** The attachment as the Attempt's delegations see it. */
  readonly delegation: DelegationAttachment;
}

/** Returns the attachment of Attempt `attemptId`, which no call relays yet. */
export const attachmentFor = Effect.fn("Attachment.make")(function* (attemptId: AttemptId) {
  const state = yield* SubscriptionRef.make<State>(detached);
  let calls = 0;

  /** Waits until the state satisfies `matches`, and returns it. */
  const awaitState = <S extends State>(matches: (current: State) => current is S) =>
    SubscriptionRef.changes(state).pipe(
      Stream.filter(matches),
      Stream.runHead,
      // `changes` never ends, so the first match always arrives.
      Effect.flatMap(Option.match({ onNone: () => Effect.never, onSome: Effect.succeed })),
    );

  const isDetached = (current: State): current is Detached => current._tag === "Detached";
  const isAttached = (current: State): current is Attached => current._tag === "Attached";

  const detach = (call: CallNumber) =>
    SubscriptionRef.update(state, (current) =>
      current._tag !== "Detached" && current.call === call ? detached : current,
    );

  const hold = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const call = ++calls;
      while (true) {
        const held = yield* SubscriptionRef.modify(state, (current): [boolean, State] =>
          current._tag === "Detached"
            ? [true, { _tag: "Attaching", call, ending: Option.none() }]
            : [false, current],
        );
        if (held) {
          yield* Effect.addFinalizer(() => detach(call));
          return call;
        }
        yield* Effect.logWarning(
          "Another execute call is relaying this Attempt; waiting for it to detach",
          { attemptId },
        );
        yield* restore(awaitState(isDetached));
      }
    }),
  );

  const nextAttached = awaitState(isAttached);

  return {
    hold,
    publish: (call, request) =>
      SubscriptionRef.update(state, (current): State =>
        current._tag === "Attaching" && current.call === call
          ? { _tag: "Attached", call, request, ending: current.ending }
          : current,
      ),
    release: SubscriptionRef.update(state, (current): State =>
      current._tag === "Attached"
        ? { _tag: "Releasing", call: current.call, ending: current.ending }
        : current,
    ),
    end: (ending) =>
      SubscriptionRef.modify(state, (current): [Option.Option<CallNumber>, State] =>
        current._tag === "Detached"
          ? [Option.none(), current]
          : [
              Option.some(current.call),
              { ...current, ending: Option.orElse(current.ending, () => Option.some(ending)) },
            ],
      ),
    ending: SubscriptionRef.get(state).pipe(
      Effect.map((current) =>
        current._tag === "Detached" ? Option.none<Ending>() : current.ending,
      ),
    ),
    canceled: awaitState(
      (current): current is Attaching | Attached | Releasing =>
        current._tag !== "Detached" && Option.contains(current.ending, "canceled"),
    ).pipe(Effect.asVoid),
    request: nextAttached.pipe(Effect.map(({ request }) => request)),
    detached: (call) =>
      awaitState((current): current is State => isDetached(current) || current.call !== call).pipe(
        Effect.asVoid,
      ),
    isDetached: SubscriptionRef.get(state).pipe(Effect.map(isDetached)),
    delegation: {
      isAttached: SubscriptionRef.get(state).pipe(Effect.map(isAttached)),
      next: nextAttached.pipe(
        Effect.map(({ call, request }): AttachedCall => ({
          request,
          stopped: SubscriptionRef.get(state).pipe(
            Effect.map((current) => !(current._tag === "Attached" && current.call === call)),
          ),
        })),
      ),
    },
  } satisfies Attachment;
});

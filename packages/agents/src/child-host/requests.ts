import { type Brand, Deferred, type Duration, Effect, Option, Ref, Schema } from "effect";
import type { SessionOperation, SessionOperationError } from "../runtime.ts";

const REQUEST_TIMEOUT = "60 seconds" satisfies Duration.Input;

/** A request on a child's line protocol got no answer within `timeout`. */
export class RequestTimedOut extends Schema.TaggedError<
  RequestTimedOut,
  Brand.Brand<"@usine/agents/child-host/RequestTimedOut">
>("@usine/agents/RequestTimedOut")("RequestTimedOut", {
  timeout: Schema.String,
}) {}

/**
 * A request ID on a child's line protocol: a sequence number, or `<generation>:<sequence>` when the
 * process owner relays the child.
 */
type RequestId = number | string;

/** A request that waits for its answer. */
interface PendingRequest<A> {
  readonly operation: SessionOperation;
  readonly answer: Deferred.Deferred<A, SessionOperationError>;
}

/** The requests that wait for an answer on one connection to a child's line protocol. */
export interface PendingRequests<A> {
  /**
   * Registers a request for `operation` under the next ID, writes it with `write`, and waits 60
   * seconds for its answer. The ID carries `generation`, the process owner's relay generation, so an
   * answer to a request of an earlier connection matches no request of this one. Fails with
   * `write`'s error, or with the error that `timedOut` returns for a `RequestTimedOut` when no
   * answer arrives in time, and then forgets the request.
   */
  readonly send: (request: {
    readonly operation: SessionOperation;
    readonly generation: Option.Option<number>;
    readonly write: (id: RequestId) => Effect.Effect<void, SessionOperationError>;
    readonly timedOut: (cause: RequestTimedOut) => SessionOperationError;
  }) => Effect.Effect<A, SessionOperationError>;
  /** Removes and returns the request that waits for `id`, or `None` when no request waits for it. */
  readonly take: (id: RequestId) => Effect.Effect<Option.Option<PendingRequest<A>>>;
  /** Fails every waiting request with the error that `reject` returns for its operation. */
  readonly rejectAll: (
    reject: (operation: SessionOperation) => SessionOperationError,
  ) => Effect.Effect<void>;
}

/** Returns an empty set of pending requests, whose IDs start at 1. */
export const pendingRequests = <A>(): Effect.Effect<PendingRequests<A>> =>
  Effect.gen(function* () {
    const waiting = yield* Ref.make(new Map<RequestId, PendingRequest<A>>());
    const nextSequence = yield* Ref.make(1);

    const take: PendingRequests<A>["take"] = (id) =>
      Ref.modify(waiting, (entries) => {
        const entry = entries.get(id);
        if (entry === undefined) return [Option.none(), entries];
        const remaining = new Map(entries);
        remaining.delete(id);
        return [Option.some(entry), remaining];
      });

    const rejectAll: PendingRequests<A>["rejectAll"] = (reject) =>
      Effect.gen(function* () {
        const entries = yield* Ref.getAndSet(waiting, new Map());
        for (const entry of entries.values())
          yield* Deferred.fail(entry.answer, reject(entry.operation));
      });

    const send: PendingRequests<A>["send"] = ({ operation, generation, write, timedOut }) =>
      Effect.gen(function* () {
        const sequence = yield* Ref.getAndUpdate(nextSequence, (current) => current + 1);
        const id = Option.match(generation, {
          onNone: (): RequestId => sequence,
          onSome: (relay) => `${relay}:${sequence}`,
        });
        const answer = yield* Deferred.make<A, SessionOperationError>();
        yield* Ref.update(waiting, (entries) => new Map(entries).set(id, { operation, answer }));
        return yield* write(id).pipe(
          Effect.andThen(
            Deferred.await(answer).pipe(
              Effect.timeoutOrElse({
                duration: REQUEST_TIMEOUT,
                orElse: () =>
                  Effect.fail(timedOut(RequestTimedOut.make({ timeout: REQUEST_TIMEOUT }))),
              }),
            ),
          ),
          Effect.ensuring(take(id)),
        );
      });

    return { send, take, rejectAll };
  });

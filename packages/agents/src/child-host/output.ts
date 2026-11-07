import { Effect, Ref } from "effect";

interface Cursor {
  readonly offset: number;
  readonly skip: number;
}

interface PendingOutput {
  readonly remaining: number;
  readonly handled: number;
  readonly start: number;
  readonly offset: number;
}

/** Tracks handled bytes and their journal checkpoint in one atomic state update. */
export const outputAcknowledgements = Effect.fn("ChildHost.outputAcknowledgements")(function* () {
  const state = yield* Ref.make<{
    readonly cursor: Cursor;
    readonly pending: ReadonlyArray<PendingOutput>;
  }>({ cursor: { offset: 0, skip: 0 }, pending: [] });

  return {
    cursor: Ref.get(state).pipe(Effect.map(({ cursor }) => cursor)),
    reset: (cursor: Cursor) => Ref.update(state, (state) => ({ ...state, cursor })),
    record: (frame: PendingOutput) =>
      Ref.update(state, (state) => ({ ...state, pending: [...state.pending, frame] })),
    acknowledge: (bytes: number) =>
      Ref.update(state, (state) => {
        let remaining = bytes;
        let cursor = state.cursor;
        for (const [index, frame] of state.pending.entries()) {
          const handled = Math.min(remaining, frame.remaining);
          remaining -= handled;
          if (frame.remaining > handled)
            return {
              cursor: { offset: frame.start, skip: frame.handled + handled },
              pending: [
                {
                  ...frame,
                  remaining: frame.remaining - handled,
                  handled: frame.handled + handled,
                },
                ...state.pending.slice(index + 1),
              ],
            };
          cursor = { offset: frame.offset, skip: 0 };
        }
        return { cursor, pending: [] };
      }),
  };
});

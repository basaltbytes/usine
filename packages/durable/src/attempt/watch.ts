import type { Context as ChordContext } from "@earendil-works/chord";
import type { DocumentWatch, JsonObject } from "@earendil-works/pi-durable";

/**
 * Resolves with the first committed value of a document that `accept` takes,
 * starting with its value at acquisition. Cancelling the context rejects; the
 * watch is stopped either way.
 */
export const firstAccepted = <T extends JsonObject>(
  watch: DocumentWatch<T>,
  accept: (value: Readonly<T>) => boolean,
  context: ChordContext,
): Promise<Readonly<T>> =>
  new Promise((resolve, reject) => {
    const signal = context.abortSignal;
    const settle = (finish: () => void) => {
      signal?.removeEventListener("abort", onAbort);
      void watch.stop();
      finish();
    };
    const onAbort = () => settle(() => reject(signal?.reason));
    const initial = watch.value;
    if (initial !== null && accept(initial)) return settle(() => resolve(initial));
    if (signal?.aborted === true) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    watch.start(async (value) => {
      if (value !== null && accept(value)) settle(() => resolve(value));
    });
    void watch.closed.then((end) =>
      settle(() => reject(new Error(`The document watch ended: ${end.reason}`))),
    );
  });

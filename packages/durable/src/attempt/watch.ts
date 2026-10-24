import type { Context as ChordContext } from "@earendil-works/chord";
import type { DocumentWatch, JsonObject } from "@earendil-works/pi-durable";

/**
 * Resolves with the first committed document value that `accept` matches, starting with the current
 * value. Rejects if the context is aborted or the watch ends, and stops the watch in every case.
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

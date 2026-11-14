import { Effect, Stream } from "effect";

export const MAX_PROTOCOL_LINE_BYTES = 4 * 1024 ** 2;

/** Bounds complete and unfinished protocol lines before text or JSON decoding. */
export const boundedLines = <E, R, E2>(
  source: Stream.Stream<Uint8Array, E, R>,
  overflow: () => E2,
  finalLine: "emit" | "discard" = "emit",
  limitBytes = MAX_PROTOCOL_LINE_BYTES,
): Stream.Stream<string, E | E2, R> =>
  Stream.suspend(() => {
    const bytes = new Uint8Array(limitBytes);
    let size = 0;
    const decoder = new TextDecoder();
    const terminated =
      finalLine === "emit" ? Stream.concat(source, Stream.succeed(new Uint8Array([10]))) : source;
    return terminated.pipe(
      Stream.mapEffect((chunk) =>
        Effect.gen(function* () {
          const lines: Array<string> = [];
          let start = 0;
          while (start < chunk.length) {
            const newline = chunk.indexOf(10, start);
            const end = newline === -1 ? chunk.length : newline;
            const nextSize = size + end - start;
            if (nextSize > limitBytes) return yield* Effect.fail(overflow());
            bytes.set(chunk.subarray(start, end), size);
            size = nextSize;
            if (newline === -1) break;
            lines.push(decoder.decode(bytes.subarray(0, size)).replace(/\r$/u, ""));
            size = 0;
            start = end + 1;
          }
          return lines;
        }),
      ),
      Stream.flatMap((lines) => Stream.fromIterable(lines)),
    );
  });

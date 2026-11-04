import { Console, Effect, Clock } from "effect";
import { assert, describe, it } from "@effect/vitest";
import { loggerLayer } from "../src/logger.ts";

describe("usine logs", () => {
  it.live("start each line with the UTC date and time instead of the local time of day", () =>
    Effect.gen(function* () {
      const lines: Array<ReadonlyArray<unknown>> = [];
      const before = yield* Clock.currentTimeMillis;
      yield* Effect.logInfo("Launching Claude child session", { retries: 0 }).pipe(
        Effect.annotateLogs({ attemptId: "attempt-1" }),
        Effect.withLogSpan("launch"),
        Effect.provide(loggerLayer),
        Effect.provideService(Console.Console, {
          ...globalThis.console,
          log: (...args: ReadonlyArray<unknown>) => {
            lines.push(args);
          },
        }),
      );
      assert.lengthOf(lines, 1);
      const [prefix, ...rest] = lines[0] ?? [];
      const stamp =
        /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\] INFO \(#\d+\) launch=\d+ms:$/u.exec(
          String(prefix),
        );
      assert(stamp !== null, `unexpected prefix ${String(prefix)}`);
      const logged = Date.parse(stamp[1] ?? "");
      assert.isTrue(logged >= before && logged <= (yield* Clock.currentTimeMillis));
      assert.deepStrictEqual(rest, [
        "Launching Claude child session",
        { retries: 0 },
        { attemptId: "attempt-1" },
      ]);
    }),
  );
});

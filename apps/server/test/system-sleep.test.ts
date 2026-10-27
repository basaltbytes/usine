import { Effect, Layer, Logger, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { assert, describe, it } from "vitest";
import { warnIfSystemSleeps } from "../src/system-sleep.ts";

/** The output of `pmset -g` on a MacBook, with the `sleep` setting given. */
const pmset = (sleep: string) => `System-wide power settings:
Currently in use:
 standby              1
 Sleep On Power Button 1
 hibernatefile        /var/vm/sleepimage
 powernap             1
 networkoversleep     0
 disksleep            10
 sleep                ${sleep}
 hibernatemode        3
 ttyskeepawake        1
 displaysleep         10
 tcpkeepalive         1
 lowpowermode         0
 womp                 1
`;

/** Runs the check against `output` from pmset, and returns the warnings it logged. */
const warnings = async (output: string) => {
  const logged: Array<unknown> = [];
  const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
    if (logLevel === "Warn") logged.push(message);
  });
  const pmsetPrinting = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(123),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.make(new TextEncoder().encode(output)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        }),
      ),
    ),
  );
  await Effect.runPromise(
    warnIfSystemSleeps().pipe(
      Effect.provide(pmsetPrinting),
      Effect.provide(Logger.layer([logger])),
    ),
  );
  return logged;
};

describe("system sleep check", () => {
  it.each([
    { sleep: "1", warns: true },
    { sleep: "10 (sleep prevented by sharingd, powerd)", warns: true },
    { sleep: "1 (sleep prevented by caffeinate, powerd)", warns: false },
    { sleep: "0", warns: false },
  ])("warns when the Mac can sleep with runs open: sleep $sleep", async ({ sleep, warns }) => {
    const logged = await warnings(pmset(sleep));
    assert.lengthOf(logged, warns ? 1 : 0);
    if (warns) assert.match(JSON.stringify(logged[0]), /caffeinate -s/u);
  });
});

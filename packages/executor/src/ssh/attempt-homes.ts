import { catalog, type HarnessDescriptor } from "@usine/agents/harness";
import type { Harness } from "@usine/core/agent/brain";
import type { AttemptId } from "@usine/core/attempt";
import { safeSegment } from "@usine/core/repository";
import { Effect, Option, Ref } from "effect";
import type { RemoteCommands } from "../remote/commands.ts";
import { directChildren } from "../remote/sweep.ts";
import type { SshMachine } from "./model.ts";

/**
 * A script that prints each directory in the harness homes directory `$1` whose Attempt has no
 * checkout in the attempts directory `$2`, NUL-terminated. Prints nothing if `$1` is missing.
 */
const HOMES_WITHOUT_CHECKOUT_SCRIPT = String.raw`
set -e
[ -d "$1" ] || exit 0
for home in "$1"/* "$1"/.[!.]* "$1"/..?*; do
  [ -e "$home" ] || continue
  [ -e "$2/$(basename "$home")" ] || printf '%s\0' "$home"
done
`.trim();

/** Returns the harness home of `attemptId` in the Worker directory `workerDirectory`. */
export const attemptHomeIn = (
  workerDirectory: string,
  attemptId: AttemptId,
  harness: Harness,
): string => `${workerDirectory}/${safeSegment(harness)}/${safeSegment(attemptId)}`;

/**
 * Tracks the harness homes that Attempts in this process use. `hold` gives an Attempt its harness
 * home and removes the directory when the caller's scope closes. `sweep` removes the harness homes
 * on a long-lived machine that no Attempt holds and whose Attempt has no checkout there, which
 * a crash or a failed removal left.
 */
export const attemptHomesFor = Effect.fn("SshExecutor.attemptHomesFor")(function* (
  commands: RemoteCommands,
) {
  // The number of holds on each harness home, by path.
  const held = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const count = (home: string, change: 1 | -1) =>
    Ref.update(held, (current) => {
      const next = new Map(current);
      const holds = (current.get(home) ?? 0) + change;
      if (holds > 0) next.set(home, holds);
      else next.delete(home);
      return next;
    });

  const hold = Effect.fn("SshExecutor.holdAttemptHome")(function* (
    machine: SshMachine,
    attemptId: AttemptId,
    descriptor: HarnessDescriptor,
  ) {
    const home = attemptHomeIn(machine.workerDirectory, attemptId, descriptor.id);
    const fields = { attemptId, worker: machine.address.name, home };
    yield* Effect.annotateCurrentSpan(fields);
    // Held before the caller writes the directory, so a sweep that lists it finds the hold.
    yield* Effect.acquireRelease(count(home, 1), () =>
      commands.run("cleanup", machine.shell, "rm", ["-rf", home]).pipe(
        Effect.tap(() => Effect.logDebug("Removed the Attempt's harness home", fields)),
        Effect.tapError((error) =>
          Effect.logWarning(
            "Could not remove the Attempt's harness home; the next sweep removes it once the Attempt's checkout is gone",
            { ...fields, message: error.message },
          ),
        ),
        Effect.ignore,
        Effect.ensuring(count(home, -1)),
      ),
    );
    return home;
  });

  const sweep = Effect.fn("SshExecutor.sweepAttemptHomes")(function* (machine: SshMachine) {
    const worker = machine.address.name;
    const host = machine.shell.destination;
    yield* Effect.annotateCurrentSpan({ worker, host });
    yield* Effect.forEach(
      catalog.descriptors.filter(({ worker }) =>
        Option.exists(worker.credential, ({ home }) => Option.isSome(home)),
      ),
      (descriptor) =>
        sweepHarness(machine, descriptor).pipe(
          Effect.tapError((error) =>
            Effect.logWarning(
              "Could not sweep a harness's attempt homes; the next sweep tries again",
              { worker, host, harness: descriptor.id, message: error.message },
            ),
          ),
          Effect.ignore,
        ),
      { discard: true },
    );
  });

  const sweepHarness = Effect.fn("SshExecutor.sweepHarnessHomes")(function* (
    machine: SshMachine,
    descriptor: HarnessDescriptor,
  ) {
    const worker = machine.address.name;
    const host = machine.shell.destination;
    yield* Effect.annotateCurrentSpan({ worker, host, harness: descriptor.id });
    const root = `${machine.workerDirectory}/${safeSegment(descriptor.id)}`;
    const output = yield* commands.run("cleanup", machine.shell, "sh", [
      "-c",
      HOMES_WITHOUT_CHECKOUT_SCRIPT,
      "sh",
      root,
      `${machine.workerDirectory}/attempts`,
    ]);
    const listed = yield* directChildren("cleanup", root, output);
    // Read after the listing, so a harness home created since then can't be removed.
    const holds = yield* Ref.get(held);
    const leftovers = listed.filter((home) => !holds.has(home));
    if (leftovers.length === 0)
      return yield* Effect.logDebug("No harness home to remove on the SSH Worker", {
        worker,
        host,
        withoutCheckout: listed.length,
      });
    // Removes each harness home separately, so one failure doesn't keep the others.
    yield* Effect.forEach(
      leftovers,
      (home) =>
        commands.run("cleanup", machine.shell, "rm", ["-rf", home]).pipe(
          Effect.tap(() =>
            Effect.logInfo(
              "Removed a harness home that no Attempt holds and whose Attempt has no checkout",
              { worker, host, home },
            ),
          ),
          Effect.tapError((error) =>
            Effect.logWarning("Could not remove a harness home; the next sweep tries again", {
              worker,
              host,
              home,
              message: error.message,
            }),
          ),
          Effect.ignore,
        ),
      { discard: true },
    );
  });

  return { hold, sweep };
});

/** The harness homes of the SSH executor's Attempts. See `attemptHomesFor`. */
export type AttemptHomes = Effect.Success<ReturnType<typeof attemptHomesFor>>;

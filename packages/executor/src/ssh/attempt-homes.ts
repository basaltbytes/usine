import { Harnesses } from "@usine/agents/harness/node";
import { type HarnessDescriptor } from "@usine/agents/harness";
import type { Harness } from "@usine/core/agent/brain";
import type { AttemptId } from "@usine/core/attempt";
import { safeSegment } from "@usine/core/repository";
import { Effect, Option, Ref } from "effect";
import type { ExecutorOperation } from "../executor.ts";
import type { AttemptIsolation } from "../remote/container.ts";
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

/** Removes the home `$1` only after its attempt's checkout `$2` is gone. */
const RELEASE_HOME_SCRIPT = String.raw`
set -e
if [ -e "$2" ]; then
  printf 'retained'
else
  rm -rf "$1"
  printf 'removed'
fi
`.trim();

/** Returns the harness home of `attemptId` in the Worker directory `workerDirectory`. */
export const attemptHomeIn = (
  workerDirectory: string,
  attemptId: AttemptId,
  harness: Harness,
): string => `${workerDirectory}/${safeSegment(harness)}/${safeSegment(attemptId)}`;

/**
 * Tracks the harness homes that Attempts in this process use. `hold` gives an Attempt its harness
 * home and removes the directory on scope closure only if its checkout is gone. `sweep` removes
 * harness homes on a long-lived machine that no Attempt holds and whose Attempt has no checkout
 * there, which a crash or a failed removal left.
 */
export const attemptHomesFor = Effect.fn("SshExecutor.attemptHomesFor")(function* (
  commands: RemoteCommands,
) {
  const { catalog } = yield* Harnesses;
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
    const checkout = `${machine.workerDirectory}/attempts/${safeSegment(attemptId)}`;
    const fields = { attemptId, worker: machine.address.name, home };
    yield* Effect.annotateCurrentSpan(fields);
    // Held before the caller writes the directory, so a sweep that lists it finds the hold.
    yield* Effect.acquireRelease(count(home, 1), () =>
      commands
        .run("cleanup", machine.shell, "sh", ["-c", RELEASE_HOME_SCRIPT, "sh", home, checkout])
        .pipe(
          Effect.tap((outcome) =>
            outcome === "retained"
              ? Effect.logInfo(
                  "Kept the Attempt's harness home because its checkout remains",
                  fields,
                )
              : Effect.logDebug("Removed the Attempt's harness home", fields),
          ),
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

  const mounts = Effect.fn("SshExecutor.prepareSessionMounts")(function* (
    machine: SshMachine,
    attemptId: AttemptId,
    harness: Option.Option<Harness>,
    isolation: AttemptIsolation,
    operation: ExecutorOperation,
  ) {
    yield* Effect.annotateCurrentSpan({ attemptId, worker: machine.address.name });
    if (isolation._tag === "SharedUser") return [];
    const directories = catalog.descriptors
      .filter(({ id }) => Option.isNone(harness) || harness.value === id)
      .flatMap((descriptor) =>
        Option.toArray(descriptor.worker.sessionDirectory).map((directory) => ({
          descriptor,
          directory,
        })),
      );
    return yield* Effect.forEach(directories, ({ descriptor, directory }) =>
      Effect.gen(function* () {
        const home = yield* hold(machine, attemptId, descriptor);
        yield* commands.run(operation, machine.shell, "sh", [
          "-c",
          'umask 077; mkdir -p "$1"',
          "sh",
          home,
        ]);
        yield* Effect.logInfo("Prepared the attempt's persistent session directory", {
          attemptId,
          worker: machine.address.name,
          harness: descriptor.id,
          home,
        });
        return { source: home, destination: `/home/usine/${directory}` };
      }),
    );
  });

  const sweep = Effect.fn("SshExecutor.sweepAttemptHomes")(function* (machine: SshMachine) {
    const worker = machine.address.name;
    const host = machine.shell.destination;
    yield* Effect.annotateCurrentSpan({ worker, host });
    yield* Effect.forEach(
      catalog.descriptors.filter(({ worker }) => worker.hasAttemptHome),
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

  return { hold, mounts, sweep };
});

/** The harness homes of the SSH executor's Attempts. See `attemptHomesFor`. */
export type AttemptHomes = Effect.Success<ReturnType<typeof attemptHomesFor>>;

import type { AttemptId } from "@usine/core/attempt";
import { safeSegment } from "@usine/core/repository";
import { Effect, Ref } from "effect";
import type { RemoteCommands } from "../remote/commands.ts";
import { directChildren } from "../remote/sweep.ts";
import type { SshMachine } from "./model.ts";

/**
 * A script that prints each directory in the Codex homes directory `$1` whose Attempt has no
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

/** Returns the Attempt's Codex home on `machine`, which Codex also writes its sessions to. */
export const attemptCodexHome = (machine: SshMachine, attemptId: AttemptId): string =>
  `${machine.workerDirectory}/codex/${safeSegment(attemptId)}`;

/**
 * Tracks the Codex homes that Attempts in this process use. `hold` gives an Attempt its Codex
 * home and removes the directory when the caller's scope closes. `sweep` removes the Codex homes
 * on a long-lived machine that no Attempt holds and whose Attempt has no checkout there, which
 * a crash or a failed removal left.
 */
export const codexHomesFor = Effect.fn("SshExecutor.codexHomesFor")(function* (
  commands: RemoteCommands,
) {
  // The number of holds on each Codex home, by path.
  const held = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const count = (codexHome: string, change: 1 | -1) =>
    Ref.update(held, (current) => {
      const next = new Map(current);
      const holds = (current.get(codexHome) ?? 0) + change;
      if (holds > 0) next.set(codexHome, holds);
      else next.delete(codexHome);
      return next;
    });

  const hold = Effect.fn("SshExecutor.holdCodexHome")(function* (
    machine: SshMachine,
    attemptId: AttemptId,
  ) {
    const codexHome = attemptCodexHome(machine, attemptId);
    const fields = { attemptId, worker: machine.address.name, codexHome };
    yield* Effect.annotateCurrentSpan(fields);
    // Held before the caller writes the directory, so a sweep that lists it finds the hold.
    yield* Effect.acquireRelease(count(codexHome, 1), () =>
      commands.run("cleanup", machine.shell, "rm", ["-rf", codexHome]).pipe(
        Effect.tap(() => Effect.logDebug("Removed the Attempt's Codex home", fields)),
        Effect.tapError((error) =>
          Effect.logWarning(
            "Could not remove the Attempt's Codex home; the next sweep removes it once the Attempt's checkout is gone",
            { ...fields, message: error.message },
          ),
        ),
        Effect.ignore,
        Effect.ensuring(count(codexHome, -1)),
      ),
    );
    return codexHome;
  });

  const sweep = Effect.fn("SshExecutor.sweepCodexHomes")(function* (machine: SshMachine) {
    const worker = machine.address.name;
    const host = machine.shell.destination;
    yield* Effect.annotateCurrentSpan({ worker, host });
    const root = `${machine.workerDirectory}/codex`;
    const output = yield* commands.run("cleanup", machine.shell, "sh", [
      "-c",
      HOMES_WITHOUT_CHECKOUT_SCRIPT,
      "sh",
      root,
      `${machine.workerDirectory}/attempts`,
    ]);
    const listed = yield* directChildren("cleanup", root, output);
    // Read after the listing, so a Codex home created since then can't be removed.
    const holds = yield* Ref.get(held);
    const leftovers = listed.filter((codexHome) => !holds.has(codexHome));
    if (leftovers.length === 0)
      return yield* Effect.logDebug("No Codex home to remove on the SSH Worker", {
        worker,
        host,
        withoutCheckout: listed.length,
      });
    // Removes each Codex home separately, so one failure doesn't keep the others.
    yield* Effect.forEach(
      leftovers,
      (codexHome) =>
        commands.run("cleanup", machine.shell, "rm", ["-rf", codexHome]).pipe(
          Effect.tap(() =>
            Effect.logInfo(
              "Removed a Codex home that no Attempt holds and whose Attempt has no checkout",
              { worker, host, codexHome },
            ),
          ),
          Effect.tapError((error) =>
            Effect.logWarning("Could not remove a Codex home; the next sweep tries again", {
              worker,
              host,
              codexHome,
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

/** The Codex homes of the SSH executor's Attempts. See `codexHomesFor`. */
export type CodexHomes = Effect.Success<ReturnType<typeof codexHomesFor>>;

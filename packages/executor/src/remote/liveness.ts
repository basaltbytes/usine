import { RemoteShell } from "@usine/agents/child-host";
import type { AttemptId } from "@usine/core/attempt";
import {
  type WorkerNotice,
  WorkerResponsive,
  WorkerUnresponsive,
} from "@usine/core/attempt/channel";
import type { WorkerName } from "@usine/core/worker";
import { DateTime, Effect, Fiber, Match, Option, Ref, type Scope, Semaphore } from "effect";
import type { RemoteCommands } from "./commands.ts";

/** How long the executor waits between two probes of a Worker while an Attempt runs on it. */
const PROBE_INTERVAL = "1 minute";
/** The SSH client's own bound on the TCP connection, the server's banner, and the key exchange. */
const CONNECT_TIMEOUT_SECONDS = 20;
/** The bound on a whole probe, so a session that opens but never runs its command counts as no answer. */
const PROBE_TIMEOUT_SECONDS = 45;

type Probe =
  | { readonly _tag: "Answered" }
  | { readonly _tag: "Unanswered"; readonly reason: string };

/** Whether the Worker answered its last probe, and when it last did. */
type Liveness =
  | { readonly _tag: "Answering"; readonly lastAnsweredAt: DateTime.Utc }
  | {
      readonly _tag: "Silent";
      readonly lastAnsweredAt: DateTime.Utc;
      /** Probes in a row that got no answer. */
      readonly unanswered: number;
    };

/** The liveness after a probe, and the notice it gives the Attempts' transcripts, if any. */
interface Observation {
  readonly liveness: Liveness;
  readonly notice: Option.Option<WorkerNotice>;
}

/**
 * The liveness after a probe at `now`, and the notice for the Attempts'
 * transcripts: one when the Worker stops answering, one when it answers
 * again, and none while it stays as it was.
 */
const observe = (
  worker: WorkerName,
  liveness: Liveness,
  probe: Probe,
  now: DateTime.Utc,
): Observation => {
  if (probe._tag === "Answered")
    return {
      liveness: { _tag: "Answering", lastAnsweredAt: now },
      notice:
        liveness._tag === "Silent"
          ? Option.some(new WorkerResponsive({ worker, lastAnsweredAt: liveness.lastAnsweredAt }))
          : Option.none(),
    };
  return liveness._tag === "Silent"
    ? { liveness: { ...liveness, unanswered: liveness.unanswered + 1 }, notice: Option.none() }
    : {
        liveness: { _tag: "Silent", lastAnsweredAt: liveness.lastAnsweredAt, unanswered: 1 },
        notice: Option.some(
          new WorkerUnresponsive({
            worker,
            lastAnsweredAt: liveness.lastAnsweredAt,
            reason: probe.reason,
          }),
        ),
      };
};

const lastLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .at(-1) ?? "";

/** An Attempt that hears about the liveness of the Worker it runs on. */
interface WorkerWatcher {
  readonly attemptId: AttemptId;
  /** Records a notice in the Attempt's transcript. */
  readonly report: (notice: WorkerNotice) => Effect.Effect<void>;
}

/** What `WorkerWatches.watch` needs to probe an Attempt's Worker and report on it. */
interface WorkerWatch extends WorkerWatcher {
  readonly worker: WorkerName;
  /** The machine's own child host; the probe sends no Attempt secret. */
  readonly shell: RemoteShell;
}

/** The liveness watches of one executor: one per Worker while any Attempt runs on it. */
export interface WorkerWatches {
  /**
   * Adds the Attempt to its Worker's watch until the caller's scope closes.
   * The first Attempt on a Worker starts the watch, and the last one to
   * leave ends it. The watch runs `true` on the Worker's machine over a new
   * SSH connection every minute, and reports through the `report` of every
   * Attempt on the Worker and a log line when the machine stops answering
   * and when it answers again. It never stops or fails an Attempt, whatever
   * the Worker does (ADR 0013).
   */
  readonly watch: (watch: WorkerWatch) => Effect.Effect<void, never, Scope.Scope>;
}

/** Probes one Worker every minute until interrupted, and reports to the Attempts `watchers` returns at each probe. */
const watchWorker = (
  commands: RemoteCommands,
  worker: WorkerName,
  machineShell: RemoteShell,
  watchers: () => ReadonlyArray<WorkerWatcher>,
): Effect.Effect<never> =>
  Effect.gen(function* () {
    const host = machineShell.destination;
    const shell = new RemoteShell({
      ssh: {
        command: machineShell.ssh.command,
        args: [...machineShell.ssh.args, "-o", `ConnectTimeout=${CONNECT_TIMEOUT_SECONDS}`],
      },
      sshEnvironment: machineShell.sshEnvironment,
      destination: machineShell.destination,
    });
    const liveness = yield* Ref.make<Liveness>({
      _tag: "Answering",
      lastAnsweredAt: yield* DateTime.now,
    });

    const probe: Effect.Effect<Probe> = commands.inspect("launch", shell, "true", []).pipe(
      Effect.timeoutOption(`${PROBE_TIMEOUT_SECONDS} seconds`),
      Effect.map(
        Option.match({
          onNone: (): Probe => ({
            _tag: "Unanswered",
            reason: `No answer within ${PROBE_TIMEOUT_SECONDS} seconds`,
          }),
          onSome: (result): Probe =>
            result.exitCode === 0
              ? { _tag: "Answered" }
              : {
                  _tag: "Unanswered",
                  reason: [`ssh exited with code ${result.exitCode}`, lastLine(result.stderr)]
                    .filter((part) => part !== "")
                    .join(": "),
                },
        }),
      ),
      Effect.catch((error) => Effect.succeed<Probe>({ _tag: "Unanswered", reason: error.message })),
    );

    // The watch outlives the Attempt whose launch started it, so each probe is its own trace.
    const check = Effect.fn("RemoteExecutor.probeWorker", { root: true })(function* () {
      yield* Effect.annotateCurrentSpan({ worker, host });
      const result = yield* probe;
      const previous = yield* Ref.get(liveness);
      const next = observe(worker, previous, result, yield* DateTime.now);
      yield* Ref.set(liveness, next.liveness);
      const watching = watchers();
      const fields = {
        worker,
        host,
        attemptIds: watching.map(({ attemptId }) => attemptId),
        lastAnsweredAt: DateTime.formatIso(previous.lastAnsweredAt),
      };
      yield* Match.valueTags(result, {
        Answered: () =>
          previous._tag === "Silent"
            ? Effect.logInfo("The Worker answers again", {
                ...fields,
                unansweredProbes: previous.unanswered,
              })
            : Effect.logDebug("The Worker answered its liveness probe", fields),
        Unanswered: ({ reason }) =>
          Effect.logWarning(
            previous._tag === "Silent"
              ? "The Worker still does not answer"
              : "The Worker stopped answering",
            {
              ...fields,
              unansweredProbes: previous._tag === "Silent" ? previous.unanswered + 1 : 1,
              reason,
            },
          ),
      });
      if (Option.isSome(next.notice)) {
        const notice = next.notice.value;
        yield* Effect.forEach(watching, ({ report }) => report(notice), { discard: true });
      }
    });

    return yield* Effect.sleep(PROBE_INTERVAL).pipe(Effect.andThen(check()), Effect.forever);
  });

/** One Worker's running watch and the Attempts it reports to. */
interface Watched {
  readonly watchers: Map<AttemptId, WorkerWatcher>;
  readonly fiber: Fiber.Fiber<never>;
}

/**
 * The liveness watches of an executor that reaches its Workers' machines
 * with `commands`. Each watch runs in the caller's scope, so the executor's
 * layer ends any watch still running when it closes.
 */
export const workerWatchesFor = (
  commands: RemoteCommands,
): Effect.Effect<WorkerWatches, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const lock = yield* Semaphore.make(1);
    const watched = new Map<WorkerName, Watched>();

    const join = (watch: WorkerWatch) =>
      Semaphore.withPermit(
        lock,
        Effect.gen(function* () {
          const fields = { attemptId: watch.attemptId, worker: watch.worker };
          const existing = watched.get(watch.worker);
          if (existing !== undefined) {
            existing.watchers.set(watch.attemptId, watch);
            return yield* Effect.logDebug("The Attempt joins its Worker's liveness watch", {
              ...fields,
              attempts: existing.watchers.size,
            });
          }
          const watchers = new Map<AttemptId, WorkerWatcher>([[watch.attemptId, watch]]);
          const fiber = yield* watchWorker(commands, watch.worker, watch.shell, () => [
            ...watchers.values(),
          ]).pipe(Effect.forkIn(scope));
          watched.set(watch.worker, { watchers, fiber });
          yield* Effect.logDebug("Watching the Worker while Attempts run on it", {
            ...fields,
            host: watch.shell.destination,
            interval: PROBE_INTERVAL,
          });
        }),
      );

    const leave = (watch: WorkerWatch) =>
      Semaphore.withPermit(
        lock,
        Effect.gen(function* () {
          const existing = watched.get(watch.worker);
          if (existing === undefined) return;
          existing.watchers.delete(watch.attemptId);
          if (existing.watchers.size > 0) return;
          watched.delete(watch.worker);
          yield* Fiber.interrupt(existing.fiber);
          yield* Effect.logDebug("Stopped watching the Worker; no Attempt runs on it", {
            attemptId: watch.attemptId,
            worker: watch.worker,
          });
        }),
      );

    return {
      watch: (watch) => Effect.acquireRelease(join(watch), () => leave(watch)),
    } satisfies WorkerWatches;
  });

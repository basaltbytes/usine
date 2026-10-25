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

const PROBE_INTERVAL = "1 minute";
/** The SSH `ConnectTimeout` in seconds, covering the TCP connection, server banner, and key exchange. */
const CONNECT_TIMEOUT_SECONDS = 20;
/** The timeout for a whole probe, in seconds. A session that opens but never runs the command counts as unanswered. */
const PROBE_TIMEOUT_SECONDS = 45;

type Probe =
  | { readonly _tag: "Answered" }
  | { readonly _tag: "Unanswered"; readonly reason: string };

type Liveness =
  | { readonly _tag: "Answering"; readonly lastAnsweredAt: DateTime.Utc }
  | {
      readonly _tag: "Silent";
      readonly lastAnsweredAt: DateTime.Utc;
      /** The number of consecutive unanswered probes. */
      readonly unanswered: number;
      /** The failure reported by the last probe. */
      readonly reason: string;
      /** The Attempts notified that the Worker stopped responding; only these get the "responding again" notice. */
      readonly told: ReadonlySet<AttemptId>;
    };

interface Report {
  readonly notice: WorkerNotice;
  readonly attemptIds: ReadonlyArray<AttemptId>;
}

interface Observation {
  readonly liveness: Liveness;
  readonly report: Option.Option<Report>;
}

const reportTo = (
  notice: WorkerNotice,
  attemptIds: ReadonlyArray<AttemptId>,
): Option.Option<Report> =>
  attemptIds.length === 0 ? Option.none() : Option.some({ notice, attemptIds });

/**
 * Returns the next liveness after a probe at `now`, with the notice for the `watching` Attempts.
 * On the first unanswered probe, every Attempt not yet notified gets a "stopped responding"
 * notice. When the Worker responds again, only notified Attempts get a "responding again"
 * notice.
 */
const observe = (
  worker: WorkerName,
  liveness: Liveness,
  probe: Probe,
  now: DateTime.Utc,
  watching: ReadonlyArray<AttemptId>,
): Observation => {
  if (probe._tag === "Answered")
    return {
      liveness: { _tag: "Answering", lastAnsweredAt: now },
      report:
        liveness._tag === "Silent"
          ? reportTo(
              new WorkerResponsive({ worker, lastAnsweredAt: liveness.lastAnsweredAt }),
              watching.filter((attemptId) => liveness.told.has(attemptId)),
            )
          : Option.none(),
    };
  const told = liveness._tag === "Silent" ? liveness.told : new Set<AttemptId>();
  return {
    liveness: {
      _tag: "Silent",
      lastAnsweredAt: liveness.lastAnsweredAt,
      unanswered: liveness._tag === "Silent" ? liveness.unanswered + 1 : 1,
      reason: probe.reason,
      told: new Set(watching),
    },
    report: reportTo(
      new WorkerUnresponsive({
        worker,
        lastAnsweredAt: liveness.lastAnsweredAt,
        reason: probe.reason,
      }),
      watching.filter((attemptId) => !told.has(attemptId)),
    ),
  };
};

/**
 * Returns the liveness after `attemptId` joins the watch. If the Worker is silent, an Attempt
 * not yet notified gets a "stopped responding" notice with the last probe's failure.
 */
const joinSilent = (worker: WorkerName, liveness: Liveness, attemptId: AttemptId): Observation =>
  liveness._tag === "Answering" || liveness.told.has(attemptId)
    ? { liveness, report: Option.none() }
    : {
        liveness: { ...liveness, told: new Set([...liveness.told, attemptId]) },
        report: reportTo(
          new WorkerUnresponsive({
            worker,
            lastAnsweredAt: liveness.lastAnsweredAt,
            reason: liveness.reason,
          }),
          [attemptId],
        ),
      };

const lastLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .at(-1) ?? "";

interface WorkerWatcher {
  readonly attemptId: AttemptId;
  /** Records a notice in the Attempt's transcript. */
  readonly report: (notice: WorkerNotice) => Effect.Effect<void>;
}

interface WorkerWatch extends WorkerWatcher {
  readonly worker: WorkerName;
  /** The machine's shell, without Attempt secrets. */
  readonly shell: RemoteShell;
}

/** The liveness watches of one executor, one per machine with a running Attempt. */
export interface WorkerWatches {
  /**
   * Adds the Attempt to its Worker's watch until the caller's scope closes. Every minute, the
   * watch runs `true` on the machine over a new SSH connection; when the machine stops or resumes
   * responding, it calls `report` for each Attempt and logs a line. Never stops or fails an
   * Attempt (ADR 0013).
   */
  readonly watch: (watch: WorkerWatch) => Effect.Effect<void, never, Scope.Scope>;
}

/**
 * Probes one Worker every minute until interrupted, stores the result in `liveness`, and
 * reports to the Attempts from `watchers`. Holds `lock` from reading `liveness` to the last
 * report, so each Attempt gets its notices in order.
 */
const watchWorker = (
  commands: RemoteCommands,
  worker: WorkerName,
  machineShell: RemoteShell,
  lock: Semaphore.Semaphore,
  liveness: Ref.Ref<Liveness>,
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

    const decide = (result: Probe) =>
      Effect.gen(function* () {
        const watching = watchers();
        const attemptIds = watching.map(({ attemptId }) => attemptId);
        const previous = yield* Ref.get(liveness);
        const next = observe(worker, previous, result, yield* DateTime.now, attemptIds);
        yield* Ref.set(liveness, next.liveness);
        const fields = {
          worker,
          host,
          attemptIds,
          notifiedAttemptIds: Option.match(next.report, {
            onNone: () => [],
            onSome: ({ attemptIds }) => attemptIds,
          }),
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
        if (Option.isSome(next.report)) {
          const { notice, attemptIds: notified } = next.report.value;
          yield* Effect.forEach(
            watching.filter(({ attemptId }) => notified.includes(attemptId)),
            ({ report }) => report(notice),
            { discard: true },
          );
        }
      });

    // Root span: the watch can run longer than the Attempt that started it.
    const check = Effect.fn("RemoteExecutor.probeWorker", { root: true })(function* () {
      yield* Effect.annotateCurrentSpan({ worker, host });
      const result = yield* probe;
      yield* Semaphore.withPermit(lock, decide(result));
    });

    return yield* Effect.sleep(PROBE_INTERVAL).pipe(Effect.andThen(check()), Effect.forever);
  });

interface Watched {
  readonly liveness: Ref.Ref<Liveness>;
  readonly watchers: Map<AttemptId, WorkerWatcher>;
  readonly fiber: Fiber.Fiber<never>;
}

/**
 * Returns the liveness watches that probe Workers' machines through `commands`. Each watch runs
 * in the caller's scope and stops when that scope closes.
 */
export const workerWatchesFor = (
  commands: RemoteCommands,
): Effect.Effect<WorkerWatches, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const lock = yield* Semaphore.make(1);
    // Keyed by Worker and destination, since a provisioned Worker has one machine per Attempt.
    const watched = new Map<string, Watched>();
    const keyOf = (watch: WorkerWatch) => `${watch.worker} ${watch.shell.destination}`;

    const join = (watch: WorkerWatch) =>
      Semaphore.withPermit(
        lock,
        Effect.gen(function* () {
          const fields = { attemptId: watch.attemptId, worker: watch.worker };
          const existing = watched.get(keyOf(watch));
          if (existing !== undefined) {
            existing.watchers.set(watch.attemptId, watch);
            const current = yield* Ref.get(existing.liveness);
            const joined = { ...fields, attempts: existing.watchers.size };
            if (current._tag === "Answering")
              return yield* Effect.logDebug(
                "The Attempt joins its Worker's liveness watch",
                joined,
              );
            const next = joinSilent(watch.worker, current, watch.attemptId);
            yield* Ref.set(existing.liveness, next.liveness);
            yield* Effect.logInfo(
              Option.isSome(next.report)
                ? "The Attempt joins its Worker's liveness watch while the Worker does not answer, and is told so"
                : "The Attempt joins its Worker's liveness watch while the Worker does not answer; it was told so already",
              {
                ...joined,
                lastAnsweredAt: DateTime.formatIso(current.lastAnsweredAt),
                unansweredProbes: current.unanswered,
                reason: current.reason,
              },
            );
            if (Option.isSome(next.report)) yield* watch.report(next.report.value.notice);
            return;
          }
          const liveness = yield* Ref.make<Liveness>({
            _tag: "Answering",
            lastAnsweredAt: yield* DateTime.now,
          });
          const watchers = new Map<AttemptId, WorkerWatcher>([[watch.attemptId, watch]]);
          const fiber = yield* watchWorker(
            commands,
            watch.worker,
            watch.shell,
            lock,
            liveness,
            () => [...watchers.values()],
          ).pipe(Effect.forkIn(scope));
          watched.set(keyOf(watch), { liveness, watchers, fiber });
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
          const existing = watched.get(keyOf(watch));
          if (existing === undefined) return;
          existing.watchers.delete(watch.attemptId);
          if (existing.watchers.size > 0) return;
          watched.delete(keyOf(watch));
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

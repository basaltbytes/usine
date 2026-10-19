import { RemoteShell } from "@usine/agents/child-host";
import type { AttemptId } from "@usine/core/attempt";
import {
  type WorkerNotice,
  WorkerResponsive,
  WorkerUnresponsive,
} from "@usine/core/attempt/channel";
import type { WorkerName } from "@usine/core/worker";
import { DateTime, Effect, Match, Option, Ref } from "effect";
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

/** The liveness after a probe, and the notice it gives the Attempt's transcript, if any. */
interface Observation {
  readonly liveness: Liveness;
  readonly notice: Option.Option<WorkerNotice>;
}

/**
 * The liveness after a probe at `now`, and the notice for the Attempt's
 * transcript: one when the Worker stops answering, one when it answers again,
 * and none while it stays as it was.
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

/** What `watchWorker` needs to probe one Attempt's Worker and report on it. */
export interface WorkerWatch {
  readonly attemptId: AttemptId;
  readonly worker: WorkerName;
  /** The machine's own child host; the probe sends no Attempt secret. */
  readonly shell: RemoteShell;
  /** Records a notice in the Attempt's transcript. */
  readonly report: (notice: WorkerNotice) => Effect.Effect<void>;
}

/**
 * Runs `true` on the Worker's machine over a new SSH connection every minute
 * until interrupted, and reports through `watch.report` and a log line when
 * the machine stops answering and when it answers again. It never stops or
 * fails the Attempt, whatever the Worker does (ADR 0013).
 */
export const watchWorker = (commands: RemoteCommands, watch: WorkerWatch): Effect.Effect<never> =>
  Effect.gen(function* () {
    const host = watch.shell.destination;
    const shell = new RemoteShell({
      ssh: {
        command: watch.shell.ssh.command,
        args: [...watch.shell.ssh.args, "-o", `ConnectTimeout=${CONNECT_TIMEOUT_SECONDS}`],
      },
      sshEnvironment: watch.shell.sshEnvironment,
      destination: watch.shell.destination,
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

    const check = Effect.fn("RemoteExecutor.probeWorker")(function* () {
      yield* Effect.annotateCurrentSpan({ attemptId: watch.attemptId, worker: watch.worker, host });
      const result = yield* probe;
      const previous = yield* Ref.get(liveness);
      const next = observe(watch.worker, previous, result, yield* DateTime.now);
      yield* Ref.set(liveness, next.liveness);
      const fields = {
        attemptId: watch.attemptId,
        worker: watch.worker,
        host,
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
      if (Option.isSome(next.notice)) yield* watch.report(next.notice.value);
    });

    yield* Effect.logDebug("Watching the Worker while the Attempt runs", {
      attemptId: watch.attemptId,
      worker: watch.worker,
      host,
      interval: PROBE_INTERVAL,
    });
    return yield* Effect.sleep(PROBE_INTERVAL).pipe(Effect.andThen(check()), Effect.forever);
  });

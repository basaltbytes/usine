import { createServer } from "node:net";
import type { RemoteShell } from "@usine/agents/child-host";
import { type GatewayAdminPort, SshDestination } from "@usine/core/worker";
import { DateTime, Deferred, Effect, Fiber, Option, Ref, Result, Schema, Stream } from "effect";
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process";

/** What the forward's SSH client prints, through OpenSSH's `LocalCommand`, once its local port listens. */
const OPEN_LINE = "usine-gateway-forward-open";

/** How long one SSH client may take to connect and listen before the executor ends it and starts another. */
const OPEN_TIMEOUT = "30 seconds";

/** How long a request waits for the forward to open; the forward answers sooner unless its own fiber stopped. */
const OPEN_WAIT = "1 minute";

/** The pause before the next SSH client doubles after each failure, from one second up to this. */
const MAX_PAUSE_MILLIS = 60_000;

/** The forward to a Gateway's admin API while one SSH client carries it. */
export interface OpenForward {
  /** Which SSH client carries the forward, counted from 1; a reopen replaces exactly this one. */
  readonly generation: number;
  /** The admin API at the forward's local port. */
  readonly url: URL;
}

/**
 * The executor's forward to a Gateway's admin API is closed: its SSH client
 * did not open, or exited and has not been replaced yet. `since` is when the
 * Gateway became unreachable through the forward, and `reason` is what the
 * SSH client reported.
 */
export class GatewayForwardClosed extends Schema.TaggedError<GatewayForwardClosed>(
  "@usine/executor/GatewayForwardClosed",
)("GatewayForwardClosed", {
  gateway: SshDestination,
  generation: Schema.Int,
  since: Schema.DateTimeUtc,
  reason: Schema.NonEmptyString,
}) {}

/**
 * The executor's own SSH forward from a local port to one Gateway's admin
 * API (ADR 0027, amendment of 2026-10-19). It opens when the executor's
 * layer is built, reopens after a pause whenever its SSH client exits, and
 * closes with the layer.
 */
export interface GatewayForward {
  /** The Gateway's SSH destination, which names it in logs and messages. */
  readonly gateway: SshDestination;
  /** The SSH client an operator runs to open the same forward by hand and see why it does not open. */
  readonly command: string;
  /** The open forward. Waits while an SSH client is opening it, and fails at once while it is closed. */
  readonly current: Effect.Effect<OpenForward, GatewayForwardClosed>;
  /**
   * Replaces SSH client `generation`, or cuts short the pause after it
   * closed, and waits for the client that follows. When another request
   * replaced it already, waits for the forward as it is now instead.
   */
  readonly reopen: (generation: number) => Effect.Effect<OpenForward, GatewayForwardClosed>;
  /**
   * Records that a request sent through the open forward at `sentAt` got no
   * answer from the Gateway's admin API, and returns when the first request
   * that got none since the last answer was sent.
   */
  readonly unanswered: (sentAt: DateTime.Utc) => Effect.Effect<DateTime.Utc>;
  /** Records that the Gateway's admin API answered a request, so the next unanswered one starts a new silence. */
  readonly answered: Effect.Effect<void>;
}

/** One SSH client of the forward, with the signals between it, the requests, and the next client. */
interface Generation {
  readonly number: number;
  /** Settles once the client listens, or fails to. */
  readonly opened: Deferred.Deferred<OpenForward, GatewayForwardClosed>;
  /** Completed by a reopen: ends the client, or the pause after it closed. */
  readonly replace: Deferred.Deferred<void>;
  /** The client that follows, once it starts. */
  readonly next: Deferred.Deferred<Generation>;
}

type ForwardState =
  | { readonly _tag: "Opening"; readonly generation: Generation }
  | { readonly _tag: "Open"; readonly generation: Generation; readonly open: OpenForward }
  | {
      readonly _tag: "Closed";
      readonly generation: Generation;
      readonly closed: GatewayForwardClosed;
    };

/** How one SSH client of the forward ended. */
type ClientEnd =
  | { readonly _tag: "NotOpened"; readonly reason: string }
  | { readonly _tag: "Exited"; readonly reason: string }
  | { readonly _tag: "Replaced" };

const notOpened = (reason: string): ClientEnd => ({ _tag: "NotOpened", reason });
const exited = (reason: string): ClientEnd => ({ _tag: "Exited", reason });
const REPLACED: ClientEnd = { _tag: "Replaced" };

/** What a TCP listener reports as its address. */
const ListenerAddress = Schema.Struct({ port: Schema.Int });

/** A port on 127.0.0.1 that the kernel picks among the free ones, released again for the SSH client to listen on. */
const freeLocalPort = Effect.callback<number, Error>((resume) => {
  const server = createServer();
  server.once("error", (cause) => resume(Effect.fail(cause)));
  server.listen(0, "127.0.0.1", () => {
    const address = Schema.decodeUnknownOption(ListenerAddress)(server.address());
    server.close(() =>
      resume(
        Option.match(address, {
          onNone: () => Effect.fail(new Error("the listener reported no port")),
          onSome: ({ port }) => Effect.succeed(port),
        }),
      ),
    );
  });
});

/** The SSH client's error output on one line, or its exit code when it printed none. */
const complaint = (stderr: string, exitCode: number): string => {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.length > 0 ? lines.join("; ") : `ssh exited with code ${String(exitCode)}`;
};

const pauseAfter = (failures: number): number =>
  Math.min(1000 * 2 ** Math.max(failures - 1, 0), MAX_PAUSE_MILLIS);

/**
 * Opens the executor's forward to the admin API at `adminPort` on the
 * Gateway at `gateway`, with the SSH client and environment of `shell`, the
 * ones the executor's other SSH clients use, and keeps it open until the
 * caller's scope closes. Each SSH client listens on a port of 127.0.0.1
 * that the kernel picks, so it never competes with a forward the operator
 * opens.
 */
export const gatewayForwardFor = Effect.fn("SshExecutor.gatewayForwardFor")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  shell: Pick<RemoteShell, "ssh" | "sshEnvironment">,
  gateway: SshDestination,
  adminPort: GatewayAdminPort,
) {
  const fields = { gateway, adminPort };
  yield* Effect.annotateCurrentSpan(fields);
  const forwardSpec = (port: number) => `127.0.0.1:${String(port)}:127.0.0.1:${String(adminPort)}`;
  const command = [
    shell.ssh.command,
    ...shell.ssh.args,
    "-N",
    "-o",
    "ExitOnForwardFailure=yes",
    "-L",
    forwardSpec(adminPort),
    gateway,
  ].join(" ");
  const argumentsFor = (port: number) => [
    ...shell.ssh.args,
    "-N",
    // LocalCommand runs once every listener is up, ExitOnForwardFailure ends a client that cannot listen, and ControlPath=none keeps it off any connection the operator shares.
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ControlPath=none",
    "-o",
    "PermitLocalCommand=yes",
    "-o",
    `LocalCommand=echo ${OPEN_LINE}`,
    "-L",
    forwardSpec(port),
    gateway,
  ];

  const generationNumbered = (number: number) =>
    Effect.all({
      opened: Deferred.make<OpenForward, GatewayForwardClosed>(),
      replace: Deferred.make<void>(),
      next: Deferred.make<Generation>(),
    }).pipe(Effect.map((signals): Generation => ({ number, ...signals })));
  const first = yield* generationNumbered(1);
  const state = yield* Ref.make<ForwardState>({ _tag: "Opening", generation: first });

  const runClient = Effect.fn("SshExecutor.runGatewayForward")(function* (
    generation: Generation,
    closedSince: Option.Option<DateTime.Utc>,
  ) {
    yield* Effect.annotateCurrentSpan({ ...fields, generation: generation.number });
    const picked = yield* Effect.result(freeLocalPort);
    if (Result.isFailure(picked))
      return notOpened(`no free port on 127.0.0.1: ${picked.failure.message}`);
    const port = picked.success;
    yield* Effect.annotateCurrentSpan({ port });
    yield* Effect.logDebug("Starting an SSH client for the forward to the Gateway's admin API", {
      ...fields,
      generation: generation.number,
      port,
    });
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(shell.ssh.command, argumentsFor(port), {
            env: { ...shell.sshEnvironment },
            extendEnv: false,
            detached: false,
            forceKillAfter: "5 seconds",
            stdin: "ignore",
          }),
        );
        const stderr = yield* handle.stderr.pipe(
          Stream.decodeText(),
          Stream.mkString,
          Effect.forkScoped,
        );
        const reported = (exitCode: number) =>
          Fiber.join(stderr).pipe(Effect.map((text) => complaint(text, exitCode)));
        const listening = yield* handle.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.filter((line) => line.trim() === OPEN_LINE),
          Stream.runHead,
          Effect.timeoutOption(OPEN_TIMEOUT),
        );
        if (Option.isNone(listening))
          return notOpened(`ssh did not open the forward within ${OPEN_TIMEOUT}`);
        if (Option.isNone(listening.value))
          return notOpened(yield* reported(Number(yield* handle.exitCode)));

        const open: OpenForward = {
          generation: generation.number,
          url: new URL(`http://127.0.0.1:${String(port)}`),
        };
        yield* Ref.set(state, { _tag: "Open", generation, open });
        yield* Deferred.succeed(generation.opened, open);
        yield* Option.match(closedSince, {
          onNone: () =>
            Effect.logInfo("Opened the forward to the Gateway's admin API", {
              ...fields,
              generation: generation.number,
              port,
            }),
          onSome: (since) =>
            Effect.logInfo("Reopened the forward to the Gateway's admin API", {
              ...fields,
              generation: generation.number,
              port,
              closedSince: DateTime.formatIso(since),
            }),
        });
        // The state leaves Open before anything else runs, so no request reads a port the client no longer holds.
        const closedNow = (reason: string) =>
          DateTime.now.pipe(
            Effect.flatMap((since) =>
              Ref.set(state, {
                _tag: "Closed",
                generation,
                closed: new GatewayForwardClosed({
                  gateway,
                  generation: generation.number,
                  since,
                  reason,
                }),
              }),
            ),
          );
        return yield* Effect.raceFirst(
          handle.exitCode.pipe(
            Effect.flatMap((code) => reported(Number(code))),
            Effect.catch((error) => Effect.succeed(`lost the SSH client: ${error.message}`)),
            Effect.tap(closedNow),
            Effect.map(exited),
          ),
          Deferred.await(generation.replace).pipe(
            Effect.andThen(closedNow("replaced at a request's demand")),
            Effect.as(REPLACED),
          ),
        );
      }),
    ).pipe(
      Effect.catch((error) =>
        Effect.succeed(notOpened(`could not run ${shell.ssh.command}: ${error.message}`)),
      ),
    );
  });

  // Runs until the caller's scope closes; each SSH client is one named span.
  const supervise = Effect.gen(function* () {
    let generation = first;
    let failures = 0;
    let closedSince = Option.none<DateTime.Utc>();
    while (true) {
      const end = yield* runClient(generation, closedSince);
      const now = yield* DateTime.now;
      if (end._tag === "Replaced") {
        failures = 0;
        closedSince = Option.some(now);
        yield* Effect.logInfo(
          "Replacing the forward to the Gateway's admin API, which a request found unanswered",
          { ...fields, generation: generation.number },
        );
      } else {
        failures = end._tag === "Exited" ? 1 : failures + 1;
        const since = end._tag === "Exited" ? now : Option.getOrElse(closedSince, () => now);
        closedSince = Option.some(since);
        const pause = pauseAfter(failures);
        const closed = new GatewayForwardClosed({
          gateway,
          generation: generation.number,
          since,
          reason: end.reason,
        });
        yield* Ref.set(state, { _tag: "Closed", generation, closed });
        yield* Deferred.fail(generation.opened, closed);
        yield* Effect.logWarning(
          end._tag === "Exited"
            ? "The forward to the Gateway's admin API exited; reopening it after a pause"
            : "Could not open the forward to the Gateway's admin API; trying again after a pause",
          {
            ...fields,
            generation: generation.number,
            closedSince: DateTime.formatIso(since),
            failures,
            pauseSeconds: pause / 1000,
            reason: end.reason,
          },
        );
        const trigger = yield* Effect.raceFirst(
          Effect.sleep(pause).pipe(Effect.as("pause elapsed")),
          Deferred.await(generation.replace).pipe(Effect.as("request")),
        );
        yield* Effect.logInfo("Reopening the forward to the Gateway's admin API", {
          ...fields,
          generation: generation.number + 1,
          closedSince: DateTime.formatIso(since),
          trigger,
        });
      }
      const next = yield* generationNumbered(generation.number + 1);
      yield* Ref.set(state, { _tag: "Opening", generation: next });
      yield* Deferred.succeed(generation.next, next);
      generation = next;
    }
  });
  yield* supervise.pipe(
    Effect.onInterrupt(() =>
      Effect.logInfo("Closed the forward to the Gateway's admin API with the executor", fields),
    ),
    Effect.forkScoped,
  );

  const notOpenedWithin = (generation: number) =>
    DateTime.now.pipe(
      Effect.flatMap(
        (since) =>
          new GatewayForwardClosed({
            gateway,
            generation,
            since,
            reason: `the forward did not open within ${OPEN_WAIT}`,
          }),
      ),
    );

  const current: GatewayForward["current"] = Effect.gen(function* () {
    const now = yield* Ref.get(state);
    switch (now._tag) {
      case "Open":
        return now.open;
      case "Closed":
        return yield* now.closed;
      case "Opening":
        return yield* Deferred.await(now.generation.opened).pipe(
          Effect.timeoutOrElse({
            duration: OPEN_WAIT,
            orElse: () => notOpenedWithin(now.generation.number),
          }),
        );
    }
  });

  const reopen = Effect.fn("SshExecutor.reopenGatewayForward")(function* (generation: number) {
    yield* Effect.annotateCurrentSpan({ ...fields, generation });
    const now = yield* Ref.get(state);
    if (now.generation.number !== generation) {
      yield* Effect.logDebug(
        "Another request replaced the forward to the Gateway's admin API already",
        { ...fields, generation, current: now.generation.number },
      );
      return yield* current;
    }
    yield* Deferred.succeed(now.generation.replace, undefined);
    return yield* Deferred.await(now.generation.next).pipe(
      Effect.flatMap((next) => Deferred.await(next.opened)),
      Effect.timeoutOrElse({
        duration: OPEN_WAIT,
        orElse: () => notOpenedWithin(generation + 1),
      }),
    );
  });

  const silentSince = yield* Ref.make(Option.none<DateTime.Utc>());
  const unanswered = (sentAt: DateTime.Utc) =>
    Ref.modify(silentSince, (since) => {
      const first = Option.match(since, {
        onNone: () => sentAt,
        onSome: (earlier) => DateTime.min(earlier, sentAt),
      });
      return [first, Option.some(first)] as const;
    });
  const answered = Ref.set(silentSince, Option.none());

  return { gateway, command, current, reopen, unanswered, answered } satisfies GatewayForward;
});

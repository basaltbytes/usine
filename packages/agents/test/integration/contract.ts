import { assert } from "@effect/vitest";
import { AgentName } from "@usine/core/agent";
import type { BrainSpec } from "@usine/core/agent/brain";
import { AgentSessionId, ChildSession, type AgentSessionEvent } from "@usine/core/agent/session";
import {
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Option,
  Path,
  type PlatformError,
  Result,
  Schedule,
  Scope,
  Stream,
} from "effect";
import { env } from "node:process";
import { fileURLToPath } from "node:url";
import {
  type ChildHost,
  childPidFile,
  LocalProcess,
  RemoteShell,
} from "../../src/child-host/child-host.ts";
import {
  ChildRequest,
  type ChildBackendService,
  type RunningSession,
  WorkingDirectory,
} from "../../src/runtime.ts";

// The test controls when the command can finish; model/network latency cannot
// race a fixed sleep. The PID proves the tool actually spawned its command;
// a broken test still releases the process within two minutes.
const waitScript = `import { existsSync, renameSync, writeFileSync } from 'node:fs';
writeFileSync('command.marker', process.env.USINE_CONTRACT_MARKER ?? '');
writeFileSync('command.pid.tmp', String(process.pid));
renameSync('command.pid.tmp', 'command.pid');
const timer = setInterval(() => {
  if (existsSync('release')) { clearInterval(timer); process.exit(0); }
}, 25);
setTimeout(() => process.exit(1), 120000).unref();
`;

/** Where a contract child runs and the environment it is given. */
export interface ContractHost {
  readonly host: ChildHost;
  readonly environment: Readonly<Record<string, string>>;
}

const MARKER = "exported-to-the-child";

const processEnvironment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

/** This machine, with this process's environment as the child's complete environment. */
export const localHost: ContractHost = {
  host: new LocalProcess(),
  environment: { ...processEnvironment(), USINE_CONTRACT_MARKER: MARKER },
};

/**
 * A remote host whose SSH client is the test shim: the remote command line
 * runs on this machine, on top of the shim's environment, as it would on a
 * Worker VM on top of the VM's own.
 */
export const shimHost: ContractHost = {
  host: new RemoteShell({
    ssh: {
      command: fileURLToPath(new URL("../fixtures/ssh-shim.sh", import.meta.url)),
      args: ["-o", "BatchMode=yes"],
    },
    sshEnvironment: processEnvironment(),
    destination: "worker.example",
  }),
  environment: { USINE_CONTRACT_MARKER: MARKER },
};

const isRunning = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
      throw error;
    }
  });

const controlledChild = <A, E, R>(
  backend: ChildBackendService,
  brain: BrainSpec,
  child: ContractHost,
  use: (
    running: RunningSession,
    release: Effect.Effect<void, PlatformError.PlatformError>,
    stopped: Effect.Effect<void>,
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: `usine-${brain.harness}-live-` });
      yield* fs.writeFileString(path.join(cwd, "wait-for-release.mjs"), waitScript);
      const session = AgentSessionId.make(`parent:${brain.harness}-live:child:1`);
      const childPid = childPidFile(cwd, session);
      yield* Effect.addFinalizer(() => fs.remove(childPid, { force: true }).pipe(Effect.ignore));
      const launch = yield* Scope.fork(yield* Effect.scope);
      const running = yield* backend
        .launch(
          new ChildRequest({
            cwd: WorkingDirectory.make(cwd),
            environment: child.environment,
            host: child.host,
            session: new ChildSession({
              id: session,
              parentId: AgentSessionId.make(`parent:${brain.harness}-live`),
              agent: AgentName.make("contract-tester"),
              brain,
            }),
            prompt: `Run exactly \`node ./wait-for-release.mjs\` in ${cwd} using your command tool. The test controls when this command exits; keep waiting until it does. Then reply with exactly ORIGINAL_INSTRUCTION. Do not run any other commands or edit files yourself.`,
          }),
        )
        .pipe(Scope.provide(launch));
      const events: Array<AgentSessionEvent> = [];
      const collected = yield* running.events.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ),
        Effect.result,
        Effect.forkChild,
      );
      const pidFile = path.join(cwd, "command.pid");
      yield* Effect.raceFirst(
        fs
          .exists(pidFile)
          .pipe(
            Effect.repeat({ while: (exists) => !exists, schedule: Schedule.spaced("25 millis") }),
          ),
        running.result.pipe(
          Effect.flatMap(({ message }) =>
            Effect.die(
              new Error(`child settled before starting the command: ${message}`, {
                cause: events.filter((event) => event._tag === "ToolFinished"),
              }),
            ),
          ),
        ),
      ).pipe(Effect.timeout("90 seconds"));
      const pid = Number(yield* fs.readFileString(pidFile));
      assert(Number.isSafeInteger(pid) && pid > 0);
      assert(yield* isRunning(pid), "the command must still be running before steer or interrupt");
      assert.strictEqual(
        yield* fs.readFileString(path.join(cwd, "command.marker")),
        MARKER,
        "the child's commands must see the environment it was given",
      );
      if (child.host._tag === "RemoteShell") {
        const recorded = Number(yield* fs.readFileString(childPid));
        assert(
          Number.isSafeInteger(recorded) && (yield* isRunning(recorded)),
          "a running remote child must record its live pid beside the worktree",
        );
      }
      const stopped = isRunning(pid).pipe(
        Effect.repeat({ while: (alive) => alive, schedule: Schedule.spaced("25 millis") }),
        Effect.asVoid,
      );
      const result = yield* use(
        running,
        fs.writeFileString(path.join(cwd, "release"), "ready"),
        stopped,
      );
      const stream = yield* Fiber.join(collected).pipe(Effect.timeout("15 seconds"));
      assert.strictEqual(events.at(0)?._tag, "SessionStarted");
      yield* Scope.close(launch, Exit.void);
      if (child.host._tag === "RemoteShell") {
        yield* fs
          .exists(childPid)
          .pipe(
            Effect.repeat({ while: (exists) => exists, schedule: Schedule.spaced("50 millis") }),
            Effect.timeout("30 seconds"),
          );
      }
      return { result, events, stream };
    }),
  );

export const steeringContract = (
  backend: ChildBackendService,
  brain: BrainSpec,
  child: ContractHost = localHost,
) =>
  controlledChild(backend, brain, child, (running, release) =>
    Effect.gen(function* () {
      const marker = `STEER_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
      yield* running.steer(
        `Change the final reply: after the command exits, reply with exactly ${marker}.`,
      );
      yield* release;
      const result = yield* running.result.pipe(Effect.timeout("90 seconds"));
      assert(
        result.message.includes(marker),
        "the child must follow guidance sent during the active turn",
      );
    }),
  ).pipe(
    Effect.map(({ events, stream }) => {
      assert(Result.isSuccess(stream), "successful work must close the event stream successfully");
      assert.strictEqual(events.at(-1)?._tag, "SessionFinished");
      assert(events.some((event) => event._tag === "TextOutput"));
      if (brain.harness === "codex") {
        const snapshots = events.filter((event) => event._tag === "PoolRateLimitsUpdated");
        assert(
          snapshots.some(
            (event) =>
              event.pool === "chatgptPlan" &&
              (Option.isSome(event.rateLimits.primary) ||
                Option.isSome(event.rateLimits.secondary)),
          ),
          "the real Codex CLI must provide at least one rate window",
        );
      }
    }),
  );

export const interruptionContract = (
  backend: ChildBackendService,
  brain: BrainSpec,
  child: ContractHost = localHost,
) =>
  controlledChild(backend, brain, child, (running, _release, stopped) =>
    Effect.gen(function* () {
      yield* running.interrupt.pipe(Effect.timeout("15 seconds"));
      const result = yield* running.result.pipe(Effect.result, Effect.timeout("15 seconds"));
      // Assert while the owning session scope is still open. Scope cleanup must
      // not conceal an interrupt implementation that leaves the tool running.
      yield* stopped.pipe(Effect.timeout("10 seconds"));
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "AgentResultError");
      else
        assert(
          !result.success.message.includes("ORIGINAL_INSTRUCTION"),
          "the waiting command must not complete normally after interrupt",
        );
      return result;
    }),
  ).pipe(
    Effect.map(({ result, events, stream }) => {
      assert.strictEqual(
        stream._tag,
        result._tag,
        "result and event stream must agree on interruption",
      );
      assert(
        !events.some(
          (event) => event._tag === "TextOutput" && event.text.includes("ORIGINAL_INSTRUCTION"),
        ),
      );
    }),
  );

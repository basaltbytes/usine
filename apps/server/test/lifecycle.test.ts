import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeServices } from "@effect/platform-node";
import { InstanceDirectory } from "@usine/core/instance";
import { RunId } from "@usine/core/run";
import { DateTime, Duration, Effect, Layer, Option, Schema } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/http";
import { afterEach, assert, describe, it } from "vitest";
import { LifecycleOptions, Port, SERVER_HOST, type UpLogLevel } from "../src/cli.ts";
import { startDetached } from "../src/detach.ts";
import { holdInstance } from "../src/instance/lock.ts";
import { ListeningPortsError } from "../src/instance/ports.ts";
import {
  InstanceLaunch,
  InstanceRecord,
  ProcessId,
  instanceFiles,
} from "../src/instance/record.ts";
import { probeInstance } from "../src/instance/state.ts";
import { restart } from "../src/restart.ts";
import { stop } from "../src/stop.ts";

const SCENARIO_TIMEOUT_MS = 60_000;
const FIXTURE = fileURLToPath(new URL("./fixtures/instance.mjs", import.meta.url));
const CLI = fileURLToPath(new URL("../src/main.ts", import.meta.url));

const folders: Array<string> = [];
const pids = new Set<number>();

afterEach(() => {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process has exited.
    }
  }
  pids.clear();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const instanceFolder = () => {
  const folder = mkdtempSync(join(tmpdir(), "usine-lifecycle-"));
  folders.push(folder);
  return InstanceDirectory.make(folder);
};

const PortAddress = Schema.Struct({ port: Port });

const freePort = () =>
  new Promise<Port>((resolve) => {
    const server = createServer();
    server.listen({ host: SERVER_HOST, port: 0 }, () => {
      const { port } = Schema.decodeUnknownSync(PortAddress)(server.address());
      server.close(() => resolve(port));
    });
  });

const services = Layer.merge(NodeServices.layer, FetchHttpClient.layer);

const run = <A, E>(
  effect: Effect.Effect<A, E, NodeServices.NodeServices | HttpClient.HttpClient>,
) => Effect.runPromise(effect.pipe(Effect.provide(services)));

const options = (seconds: number, force = false) =>
  new LifecycleOptions({ timeout: Duration.seconds(seconds), force });

/** The fallback launch of a restart that must find the instance record. */
const recordedOnly = Effect.die(new Error("usine restart used the fallback launch"));

const fixtureLaunch = async (script = FIXTURE, logLevel: UpLogLevel = "Info") =>
  new InstanceLaunch({
    node: process.execPath,
    nodeOptions: ["--experimental-strip-types", "--no-warnings"],
    script,
    port: await freePort(),
    logLevel,
    allowVolatileInstance: false,
  });

/** Starts the fixture in the background, the way `usine restart` starts `usine up`. */
const startFixture = async (
  directory: InstanceDirectory,
  script = FIXTURE,
  logLevel: UpLogLevel = "Info",
) => {
  const launch = await fixtureLaunch(script, logLevel);
  const { pid } = await run(startDetached(directory, launch, Duration.seconds(30)));
  pids.add(pid);
  return { pid, launch };
};

/**
 * Runs the `usine` CLI in `directory` and returns its standard output, or rejects with its standard
 * error if it fails. Asynchronous, so this process reaps the instance processes it started.
 */
const runCli = (directory: InstanceDirectory, args: ReadonlyArray<string>) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", CLI, ...args],
      { cwd: directory, timeout: SCENARIO_TIMEOUT_MS },
      (error, stdout, stderr) => (error === null ? resolve(stdout) : reject(new Error(stderr))),
    );
  });

const pid1OfAnotherUser =
  process.platform === "linux" && statSync("/proc/1").uid !== process.getuid?.();

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("instance lifecycle", { timeout: SCENARIO_TIMEOUT_MS }, () => {
  it("starts in the background, records the new process, and stops it after the drain", async () => {
    const directory = instanceFolder();
    const files = instanceFiles(directory);
    const record = await startFixture(directory);
    assert.match(
      readFileSync(files.log, "utf8"),
      new RegExp(`fixture listening on ${record.launch.port}`),
    );
    assert.strictEqual(readFileSync(files.pid, "utf8").trim(), String(record.pid));

    await run(stop(directory, options(20)));

    assert.isFalse(alive(record.pid));
    assert.isFalse(existsSync(files.record));
    assert.isFalse(existsSync(files.pid));
    const state = await run(probeInstance(directory));
    assert(state._tag === "Stopped");
    assert.deepStrictEqual(state.stale, Option.none());
  });

  it("restarts into a new process with the recorded launch, port, and log level", async () => {
    const directory = instanceFolder();
    const files = instanceFiles(directory);
    const first = await startFixture(directory, FIXTURE, "Debug");

    await run(restart(directory, options(20), recordedOnly));

    const state = await run(probeInstance(directory));
    assert(state._tag === "Running");
    pids.add(state.record.pid);
    assert.notStrictEqual(state.record.pid, first.pid);
    assert.isFalse(alive(first.pid));
    assert.strictEqual(state.record.launch.port, first.launch.port);
    assert.deepStrictEqual(state.record.launch.nodeOptions, first.launch.nodeOptions);
    // Both starts passed --log-level to the fixture, which recorded it as usine up does.
    assert.strictEqual(state.record.launch.logLevel, "Debug");
    assert.strictEqual(readFileSync(files.pid, "utf8").trim(), String(state.record.pid));
    const log = readFileSync(files.log, "utf8");
    assert.strictEqual(log.match(/fixture listening/gu)?.length, 2, log);
    await run(stop(directory, options(20)));
  });

  it("refuses to restart while a run has a live attempt, unless forced", async () => {
    const directory = instanceFolder();
    const first = await startFixture(directory);
    writeFileSync(
      join(directory, "fixture-runs.json"),
      JSON.stringify([
        { id: "run-live", state: "Running" },
        { id: "run-done", state: "Succeeded" },
      ]),
    );
    writeFileSync(join(directory, "fixture-drain"), "never");

    const refused = await run(restart(directory, options(20), recordedOnly).pipe(Effect.flip));
    assert(refused._tag === "LiveAttemptsError");
    assert.deepStrictEqual(refused.runs, [RunId.make("run-live")]);
    assert.isTrue(alive(first.pid), "a refused restart leaves the instance running");

    await run(restart(directory, options(20, true), recordedOnly));
    const state = await run(probeInstance(directory));
    assert(state._tag === "Running");
    pids.add(state.record.pid);
    assert.isFalse(alive(first.pid));
    await run(stop(directory, options(20, true)));
  });

  it("checks an instance without a readable record on its own port, then restarts it", async () => {
    const directory = instanceFolder();
    const files = instanceFiles(directory);
    const first = await startFixture(directory);
    const unreadable = JSON.stringify({ pid: "unreadable" });
    writeFileSync(files.record, unreadable);
    const variable = `USINE_TEST_GATEWAY_TOKEN_${process.pid}`;
    writeFileSync(join(directory, "fixture-gateway-env"), variable);
    writeFileSync(
      join(directory, "fixture-runs.json"),
      JSON.stringify([{ id: "run-live", state: "Running" }]),
    );
    writeFileSync(join(directory, "fixture-drain"), "never");
    // Nothing answers on the new port, so checks that asked it would pass and signal the instance.
    const fallback = new InstanceLaunch({
      node: first.launch.node,
      nodeOptions: first.launch.nodeOptions,
      script: FIXTURE,
      port: await freePort(),
      logLevel: "Debug",
      allowVolatileInstance: false,
    });
    assert.notStrictEqual(fallback.port, first.launch.port);

    const missing = await run(
      restart(directory, options(1), Effect.succeed(fallback)).pipe(Effect.flip),
    );
    assert(missing._tag === "MissingEnvironmentError");
    assert.deepStrictEqual(missing.variables, [variable]);
    rmSync(join(directory, "fixture-gateway-env"));
    const refused = await run(
      restart(directory, options(1), Effect.succeed(fallback)).pipe(Effect.flip),
    );
    assert(refused._tag === "LiveAttemptsError");
    assert.deepStrictEqual(refused.runs, [RunId.make("run-live")]);
    // A signal would make the fixture record its drain over the unreadable record.
    assert.strictEqual(readFileSync(files.record, "utf8"), unreadable, "no signal was sent");
    assert.isTrue(alive(first.pid), "a refused restart leaves the instance running");

    await run(restart(directory, options(20, true), Effect.succeed(fallback)));
    const state = await run(probeInstance(directory));
    assert(state._tag === "Running");
    pids.add(state.record.pid);
    assert.notStrictEqual(state.record.pid, first.pid);
    assert.isFalse(alive(first.pid));
    assert.strictEqual(state.record.launch.port, fallback.port);
    assert.strictEqual(state.record.launch.logLevel, "Debug");
    await run(stop(directory, options(20, true)));
  });

  // Another user's descriptors are unreadable, so this runs where pid 1 belongs to someone else.
  it.skipIf(!pid1OfAnotherUser)(
    "refuses to restart an instance without a readable record whose ports it can't list",
    async () => {
      const directory = instanceFolder();
      const files = instanceFiles(directory);
      const fallback = new InstanceLaunch({
        node: process.execPath,
        nodeOptions: [],
        script: FIXTURE,
        port: await freePort(),
        logLevel: "Info",
        allowVolatileInstance: false,
      });
      const refused = await run(
        Effect.gen(function* () {
          yield* holdInstance(
            directory,
            new InstanceRecord({
              pid: ProcessId.make(1),
              version: "0.3.0",
              startedAt: yield* DateTime.now,
              launch: fallback,
            }),
          );
          writeFileSync(files.record, "unreadable");
          return yield* restart(directory, options(1), Effect.succeed(fallback)).pipe(Effect.flip);
        }).pipe(Effect.scoped),
      );
      assert.instanceOf(refused, ListeningPortsError);
      assert.strictEqual(refused.pid, 1);
    },
  );

  it("waits for a long drain without sending the second signal, and --force ends it", async () => {
    const directory = instanceFolder();
    const record = await startFixture(directory);
    writeFileSync(join(directory, "fixture-drain"), "never");

    const timedOut = await run(stop(directory, options(1)).pipe(Effect.flip));
    assert(timedOut._tag === "StopTimeoutError");
    assert.isTrue(alive(record.pid));
    const stopping = await run(probeInstance(directory));
    assert(stopping._tag === "Running");
    assert.isDefined(stopping.record.stoppingSince, "the drain is recorded");

    // A second stop must not end the drain.
    const again = await run(stop(directory, options(1)).pipe(Effect.flip));
    assert(again._tag === "StopTimeoutError");
    assert.isTrue(alive(record.pid));

    await run(stop(directory, options(20, true)));
    assert.isFalse(alive(record.pid));
  });

  it("sends SIGKILL to a forced stop that doesn't exit before the timeout, and says so", async () => {
    const directory = instanceFolder();
    const record = await startFixture(directory);
    writeFileSync(join(directory, "fixture-drain"), "never");
    writeFileSync(join(directory, "fixture-close"), "never");

    const output = await runCli(directory, ["stop", "--force", "--timeout", "1"]);

    assert.match(
      output,
      new RegExp(`usine \\(pid ${record.pid}\\) did not exit within 1s\\. Sent SIGKILL`, "u"),
    );
    assert.match(output, /usine stopped\./u);
    assert.isFalse(alive(record.pid));
    const state = await run(probeInstance(directory));
    assert(state._tag === "Stopped");
  });

  it("refuses to restart while neither the shell nor .env sets a gateway token variable", async () => {
    const directory = instanceFolder();
    const first = await startFixture(directory);
    const variable = `USINE_TEST_GATEWAY_TOKEN_${process.pid}`;
    writeFileSync(join(directory, "fixture-gateway-env"), variable);

    const refused = await run(restart(directory, options(20), recordedOnly).pipe(Effect.flip));
    assert(refused._tag === "MissingEnvironmentError");
    assert.deepStrictEqual(refused.variables, [variable]);
    assert.isTrue(alive(first.pid));

    // The CLI runs from a shell without the variable, as a bare `usine restart` does.
    writeFileSync(join(directory, ".env"), `${variable}=token\n`);
    const output = await runCli(directory, ["restart", "--timeout", "20"]);
    assert.match(output, /usine is running at http:\/\/127\.0\.0\.1:\d+ \(pid \d+\)/u);
    const state = await run(probeInstance(directory));
    assert(state._tag === "Running");
    pids.add(state.record.pid);
    assert.notStrictEqual(state.record.pid, first.pid);
    await run(stop(directory, options(20)));
  });

  it("keeps waiting past the timeout while the starting process writes to its log", async () => {
    const directory = instanceFolder();
    // Six seconds of startup recovery, which logs a line every 500 milliseconds.
    writeFileSync(join(directory, "fixture-startup"), "12 500");

    const started = await run(startDetached(directory, await fixtureLaunch(), Duration.seconds(4)));
    pids.add(started.pid);

    const log = readFileSync(instanceFiles(directory).log, "utf8");
    assert.match(log, /fixture reconciled checkout 12\n[\s\S]*fixture listening/u, log);
    await run(stop(directory, options(20)));
  });

  it("reports a background start that neither listens nor writes to its log within the timeout", async () => {
    const directory = instanceFolder();
    writeFileSync(join(directory, "fixture-startup"), "never");

    const error = await run(
      startDetached(directory, await fixtureLaunch(), Duration.seconds(2)).pipe(Effect.flip),
    );
    assert(error._tag === "DetachedStartError");
    assert(Option.isSome(error.pid));
    pids.add(error.pid.value);
    assert.strictEqual(error.outcome, "silent");
    assert.isTrue(alive(error.pid.value), "the command leaves the process running");
  });

  it("fails a background start as soon as its readiness probe fails", async () => {
    const directory = instanceFolder();
    const files = instanceFiles(directory);
    mkdirSync(files.folder, { recursive: true });
    writeFileSync(files.lock, "not a database");
    const port = await freePort();
    // Another server answers on the port, so the probe reads the instance lock and fails.
    const server = createHttpServer((_, response) => response.end("ok"));
    await new Promise<void>((resolve) => server.listen({ host: SERVER_HOST, port }, resolve));
    try {
      const launch = new InstanceLaunch({
        node: process.execPath,
        // Runs without listening for longer than the probe takes, then exits on its own.
        nodeOptions: ["--eval", "setTimeout(() => {}, 5000)"],
        script: FIXTURE,
        port,
        logLevel: "Info",
        allowVolatileInstance: false,
      });
      const error = await run(
        startDetached(directory, launch, Duration.seconds(20)).pipe(Effect.flip),
      );
      assert(error._tag === "InstanceLockError", error._tag);
      assert.strictEqual(error.directory, files.folder);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports a background start whose process exits before it listens", async () => {
    const directory = instanceFolder();
    const launch = new InstanceLaunch({
      node: process.execPath,
      nodeOptions: ["--eval", "console.error('cannot start'); process.exit(3)"],
      script: FIXTURE,
      port: await freePort(),
      logLevel: "Info",
      allowVolatileInstance: false,
    });
    const error = await run(
      startDetached(directory, launch, Duration.seconds(20)).pipe(Effect.flip),
    );
    assert(error._tag === "DetachedStartError");
    assert.strictEqual(error.outcome, "exited");
    assert.deepStrictEqual(error.exit, Option.some("status 3"));
    assert.include(error.tail, "cannot start");
  });
});

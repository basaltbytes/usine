import { rejects } from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmodSync,
  symlinkSync,
  renameSync,
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
import { UiOrigin } from "@usine/config/factory";
import { LifecycleOptions, Port, SERVER_HOST, type UpLogLevel } from "../src/cli.ts";
import { startDetached } from "../src/detach.ts";
import { writeAdminToken } from "../src/auth/local.ts";
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

const fixtureLaunch = async (
  script = FIXTURE,
  logLevel: UpLogLevel = "Info",
  origin = Option.none<UiOrigin>(),
) =>
  new InstanceLaunch({
    node: process.execPath,
    nodeOptions: ["--experimental-strip-types", "--no-warnings"],
    script,
    port: await freePort(),
    origin,
    logLevel,
    allowVolatileInstance: false,
  });

/** Starts the fixture in the background, the way `usine restart` starts `usine up`. */
const startFixture = async (
  directory: InstanceDirectory,
  script = FIXTURE,
  logLevel: UpLogLevel = "Info",
  origin = Option.none<UiOrigin>(),
) => {
  const launch = await fixtureLaunch(script, logLevel, origin);
  const { pid } = await run(startDetached(directory, launch, Duration.seconds(30)));
  pids.add(pid);
  return { pid, launch };
};

/**
 * Runs the `usine` CLI in `directory` and returns its standard output, or rejects with its standard
 * error if it fails. Asynchronous, so this process reaps the instance processes it started.
 */
const runCli = (
  directory: InstanceDirectory,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", CLI, ...args],
      { cwd: directory, timeout: SCENARIO_TIMEOUT_MS, env: environment },
      (error, stdout, stderr) => (error === null ? resolve(stdout) : reject(new Error(stderr))),
    );
  });

const UNIT = "usine-test.service";

/**
 * Writes a `systemctl` that acts as systemd would for `UNIT` running the fixture in `directory`,
 * and logs its arguments to `systemctl.log` there. `show` reports the PID in `.usine/instance.pid`
 * as the main one, unless `systemctl-other-main` exists; `stop` sends it `SIGTERM`; and `start`
 * starts the fixture with `launch`'s port in the background. With `systemctl-failing`, `start`
 * starts nothing and `show` reports a service that waits to restart. With `systemctl-start-fails`,
 * `start` also fails, as for a `Type=exec` service whose command can't run. With
 * `systemctl-denied`, every verb but `show` fails as without the permission to manage the service.
 * Returns the environment for the CLI.
 */
const fakeSystemctl = (directory: InstanceDirectory, launch: InstanceLaunch) => {
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const script = join(bin, "systemctl");
  writeFileSync(
    script,
    `#!${process.execPath}
const { appendFileSync, existsSync, openSync, readFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { join } = require("node:path");
const directory = ${JSON.stringify(directory)};
const args = process.argv.slice(2);
appendFileSync(join(directory, "systemctl.log"), args.join(" ") + "\\n");
const flag = (name) => existsSync(join(directory, name));
const pidFile = join(directory, ".usine", "instance.pid");
const pid = () => (existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : 0);
const verb = args[0];
if (verb !== "show" && flag("systemctl-denied")) {
  console.error("Failed to " + verb + " " + args.at(-1) + ": Access denied");
  process.exit(4);
}
if (verb === "show" && args.includes("--property=MainPID")) {
  console.log(flag("systemctl-other-main") ? 1 : pid());
} else if (verb === "show") {
  const failing = flag("systemctl-failing") || flag("systemctl-start-fails");
  console.log(failing ? "ActiveState=activating\\nSubState=auto-restart" : "ActiveState=active\\nSubState=running");
} else if (verb === "stop" && pid() !== 0) {
  process.kill(pid(), "SIGTERM");
} else if (verb === "start" && flag("systemctl-start-fails")) {
  console.error("Job for " + args.at(-1) + " failed because the control process exited with error code.");
  process.exit(1);
} else if (verb === "start" && !flag("systemctl-failing")) {
  const log = openSync(join(directory, ".usine", "usine.log"), "a");
  spawn(${JSON.stringify(launch.node)}, ${JSON.stringify([...launch.nodeOptions, launch.script, "up", "--port", String(launch.port)])}, { cwd: directory, detached: true, stdio: ["ignore", log, log] }).unref();
}
`,
  );
  chmodSync(script, 0o755);
  return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
};

const systemctlCalls = (directory: InstanceDirectory) =>
  readFileSync(join(directory, "systemctl.log"), "utf8").trim().split("\n");

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

  it("refuses stop and restart before signaling when the admin token is unsafe or missing", async () => {
    const directory = instanceFolder();
    const first = await startFixture(directory);
    const path = join(directory, ".usine/admin-token");
    const expectRefusal = async () => {
      for (const command of ["stop", "restart"]) {
        for (const flags of [[], ["--force"]]) {
          await rejects(runCli(directory, [command, ...flags]), (error: Error) => {
            assert.include(error.message, path);
            assert.include(error.message, `uid ${process.getuid?.()}`);
            assert.include(error.message, "0600");
            return true;
          });
          assert.isTrue(alive(first.pid));
        }
      }
    };
    chmodSync(path, 0o644);
    await expectRefusal();
    chmodSync(path, 0o600);
    renameSync(path, `${path}.real`);
    symlinkSync(`${path}.real`, path);
    await expectRefusal();
    rmSync(path);
    await expectRefusal();
    writeFileSync(instanceFiles(directory).record, "unreadable");
    await expectRefusal();
  });

  it("restarts into a new process with the recorded launch, port, origin, and log level", async () => {
    const directory = instanceFolder();
    const files = instanceFiles(directory);
    const first = await startFixture(
      directory,
      FIXTURE,
      "Debug",
      Option.some(UiOrigin.make("https://usine-orchestrator.tail1234.ts.net")),
    );

    await run(restart(directory, options(20), recordedOnly));

    const state = await run(probeInstance(directory));
    assert(state._tag === "Running");
    pids.add(state.record.pid);
    assert.notStrictEqual(state.record.pid, first.pid);
    assert.isFalse(alive(first.pid));
    assert.strictEqual(state.record.launch.port, first.launch.port);
    assert.deepStrictEqual(state.record.launch.nodeOptions, first.launch.nodeOptions);
    // Both starts passed --log-level and --origin to the fixture, which recorded them as usine up does.
    assert.strictEqual(state.record.launch.logLevel, "Debug");
    assert.deepStrictEqual(state.record.launch.origin, first.launch.origin);
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
          yield* writeAdminToken(directory);
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
  it("stops, restarts, and reports an instance that a systemd service runs with systemctl", async () => {
    const directory = instanceFolder();
    writeFileSync(join(directory, "fixture-unit"), UNIT);
    const first = await startFixture(directory);
    const environment = fakeSystemctl(directory, first.launch);

    const restarted = await runCli(directory, ["restart", "--timeout", "20"], environment);
    assert.match(
      restarted,
      new RegExp(`Stopping usine \\(pid ${first.pid}\\) with systemctl stop ${UNIT}`, "u"),
    );
    assert.match(restarted, new RegExp(`usine is running at .+ \\(pid \\d+\\) in ${UNIT}`, "u"));
    const state = await run(probeInstance(directory));
    assert(state._tag === "Running");
    pids.add(state.record.pid);
    assert.notStrictEqual(state.record.pid, first.pid);
    assert.isFalse(alive(first.pid));
    assert.deepStrictEqual(Option.getOrUndefined(state.record.systemdUnit), UNIT);

    const report = await runCli(directory, ["status"], environment);
    assert.include(report, `  service   ${UNIT}, managed with systemctl`);

    await runCli(directory, ["stop", "--timeout", "20"], environment);
    assert.isFalse(alive(state.record.pid));
    const calls = systemctlCalls(directory);
    assert.deepStrictEqual(
      calls.filter((call) => !call.startsWith("show")),
      [`stop --no-block ${UNIT}`, `start ${UNIT}`, `stop --no-block ${UNIT}`],
    );
    assert.include(calls, `show --property=MainPID --value ${UNIT}`);
  });

  it("signals an instance whose systemd service has another main process, without systemctl stop", async () => {
    const directory = instanceFolder();
    // As for a usine up that a script of another service started.
    writeFileSync(join(directory, "fixture-unit"), UNIT);
    writeFileSync(join(directory, "systemctl-other-main"), "");
    const record = await startFixture(directory);
    const environment = fakeSystemctl(directory, record.launch);

    const output = await runCli(directory, ["stop", "--timeout", "20"], environment);

    assert.match(output, new RegExp(`Stopping usine \\(pid ${record.pid}\\)\\.`, "u"));
    assert.isFalse(alive(record.pid));
    assert.deepStrictEqual(systemctlCalls(directory), [`show --property=MainPID --value ${UNIT}`]);
  });

  it("names the systemctl command that this user may not run, and leaves the instance running", async () => {
    const directory = instanceFolder();
    writeFileSync(join(directory, "fixture-unit"), UNIT);
    writeFileSync(join(directory, "systemctl-denied"), "");
    const record = await startFixture(directory);
    const environment = fakeSystemctl(directory, record.launch);

    const refused = await runCli(directory, ["stop"], environment).then(
      () => "",
      (error: Error) => error.message,
    );

    assert.include(refused, `systemctl stop --no-block ${UNIT} failed`);
    assert.include(refused, "Access denied");
    assert.isTrue(alive(record.pid));
  });

  it("stops a systemd service whose new process exits before it listens, so that it doesn't restart", async () => {
    const directory = instanceFolder();
    writeFileSync(join(directory, "fixture-unit"), UNIT);
    const first = await startFixture(directory);
    const environment = fakeSystemctl(directory, first.launch);
    writeFileSync(join(directory, "systemctl-failing"), "");

    const failed = await runCli(directory, ["restart", "--timeout", "20"], environment).then(
      () => "",
      (error: Error) => error.message,
    );

    assert.include(
      failed,
      `systemctl start ${UNIT} ran, but the service was activating (auto-restart)`,
    );
    assert.isFalse(alive(first.pid));
    assert.deepStrictEqual(
      systemctlCalls(directory).filter((call) => !call.startsWith("show")),
      [`stop --no-block ${UNIT}`, `start ${UNIT}`, `stop --no-block ${UNIT}`],
    );
  });

  it("cancels the restart of a systemd service whose systemctl start fails, and names that failure", async () => {
    const directory = instanceFolder();
    writeFileSync(join(directory, "fixture-unit"), UNIT);
    const first = await startFixture(directory);
    const environment = fakeSystemctl(directory, first.launch);
    writeFileSync(join(directory, "systemctl-start-fails"), "");

    const failed = await runCli(directory, ["restart", "--timeout", "20"], environment).then(
      () => "",
      (error: Error) => error.message,
    );

    assert.include(failed, `systemctl start ${UNIT} failed`);
    assert.include(failed, "the control process exited with error code");
    assert.isFalse(alive(first.pid));
    assert.deepStrictEqual(
      systemctlCalls(directory).filter((call) => !call.startsWith("show")),
      [`stop --no-block ${UNIT}`, `start ${UNIT}`, `stop --no-block ${UNIT}`],
    );
  });
});

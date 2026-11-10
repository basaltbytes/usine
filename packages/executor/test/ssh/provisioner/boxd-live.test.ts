import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { AttemptId } from "@usine/core/attempt";
import { RunId } from "@usine/core/run";
import { BoxdSnapshotName, WorkerName } from "@usine/core/worker";
import {
  Redacted,
  Clock,
  Config,
  Effect,
  FileSystem,
  Layer,
  Option,
  Random,
  Schedule,
} from "effect";
import { FetchHttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { homedir } from "node:os";
import { remoteCommandsFor, sendingShell } from "../../../src/remote/commands.ts";
import { boxdDriverFor } from "../../../src/ssh/provisioner/boxd.ts";
import { boxdApiLayer } from "../../../src/ssh/provisioner/boxd/grpc-client.ts";
import { boxdSettings } from "./support.ts";

const environment = Effect.runSync(
  Effect.all({
    token: Config.option(Config.Redacted("BOXD_API_KEY")),
    snapshot: Config.option(Config.String("BOXD_TEST_SNAPSHOT")),
    ci: Config.option(Config.String("CI")),
  }),
);

it.live.skipIf(
  Option.isNone(environment.token) ||
    Option.isNone(environment.snapshot) ||
    Option.isSome(environment.ci),
)(
  "creates a boxd machine, pins its endpoint, round-trips an SSH variable over stdin, and destroys it",
  () =>
    Effect.gen(function* () {
      if (Option.isNone(environment.token) || Option.isNone(environment.snapshot)) return;
      const settings = boxdSettings({
        token: environment.token.value,
        snapshot: BoxdSnapshotName.make(environment.snapshot.value),
      });
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const now = yield* Clock.currentTimeMillis;
      const suffix = (yield* Random.nextIntBetween(0, 2 ** 32)).toString(16);
      const run = RunId.make(`boxd-live-${now}`);
      yield* Effect.gen(function* () {
        const driver = yield* boxdDriverFor(
          WorkerName.make("boxd-live"),
          settings,
          `${homedir()}/.ssh/usine_worker.pub`,
        );
        yield* driver.verify(WorkerName.make("boxd-live"), 1);
        yield* Effect.acquireUseRelease(
          driver.create(`boxd-live-${now}-${suffix}`, {
            instance: "usine-live-test",
            worker: WorkerName.make("boxd-live"),
            run,
            process: "live-test",
            attempt: AttemptId.make(`${run}/test/1`),
            attempts: 1,
          }),
          ({ id }) =>
            Effect.gen(function* () {
              const endpoint = yield* driver
                .endpoint(id, Effect.sleep("100 millis"))
                .pipe(Effect.timeout("2 minutes"));
              assert(Option.isSome(endpoint.hostKey) && Option.isSome(endpoint.port));
              yield* fs.writeFileString(
                `${directory}/known_hosts`,
                `boxd-live ${endpoint.hostKey.value}\n`,
              );
              const port = endpoint.port.value;
              const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
              const ssh = {
                command: "ssh",
                args: [
                  "-o",
                  "BatchMode=yes",
                  "-o",
                  "StrictHostKeyChecking=yes",
                  "-o",
                  "HostKeyAlias=boxd-live",
                  "-o",
                  `UserKnownHostsFile=${directory}/known_hosts`,
                  "-o",
                  "ConnectTimeout=15",
                  "-i",
                  `${homedir()}/.ssh/usine_worker`,
                  "-p",
                  String(port),
                ],
              };
              const connect = Effect.gen(function* () {
                const child = yield* spawner.spawn(
                  ChildProcess.make(ssh.command, [...ssh.args, endpoint.destination, "true"]),
                );
                return yield* child.exitCode.pipe(Effect.timeout("30 seconds"));
              }).pipe(Effect.scoped);
              const code = yield* connect.pipe(
                Effect.repeat({
                  while: (status) => Number(status) !== 0,
                  schedule: Schedule.spaced("2 seconds"),
                }),
                Effect.timeout("45 seconds"),
              );
              assert.strictEqual(Number(code), 0);
              const commands = yield* remoteCommandsFor;
              const base = commands.shellFor(ssh, endpoint.destination);
              const value = `boxd-stdin-${now}`;
              const shell = sendingShell(base, { USINE_BOXD_LIVE_TEST: Redacted.make(value) });
              const received = yield* commands.run("preflight", shell, "printenv", [
                "USINE_BOXD_LIVE_TEST",
              ]);
              assert.strictEqual(received, `${value}\n`);
            }),
          ({ id }) => driver.remove(id).pipe(Effect.orDie),
        );
      }).pipe(Effect.provide(boxdApiLayer(settings.token, settings.region)));
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer))),
  180_000,
);

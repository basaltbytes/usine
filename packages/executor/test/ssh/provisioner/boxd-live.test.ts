import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { AttemptId } from "@usine/core/attempt";
import { RunId } from "@usine/core/run";
import { BoxdSnapshotName, WorkerName } from "@usine/core/worker";
import { Clock, Config, Effect, FileSystem, Layer, Option, Schedule } from "effect";
import { FetchHttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { homedir } from "node:os";
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
  "creates a boxd machine, pins its endpoint, runs SSH true, and destroys it",
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
      const run = RunId.make(`boxd-live-${now}`);
      yield* Effect.gen(function* () {
        const driver = yield* boxdDriverFor(WorkerName.make("boxd-live"), settings);
        yield* driver.verify(WorkerName.make("boxd-live"), 1);
        yield* Effect.acquireUseRelease(
          driver.create("live", {
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
              const connect = Effect.gen(function* () {
                const child = yield* spawner.spawn(
                  ChildProcess.make("ssh", [
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
                    endpoint.destination,
                    "true",
                  ]),
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
            }),
          ({ id }) => driver.remove(id).pipe(Effect.orDie),
        );
      }).pipe(Effect.provide(boxdApiLayer(settings.token, settings.region)));
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer))),
  180_000,
);

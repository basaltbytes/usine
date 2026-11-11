import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { AttemptId } from "@usine/core/attempt";
import { RunId } from "@usine/core/run";
import { BoxdEgressEntry, BoxdSnapshotName, WorkerName } from "@usine/core/worker";
import { ExecShell } from "@usine/agents/child-host";
import { Redacted, Clock, Config, Effect, Layer, Option, Random, Schedule } from "effect";
import { FetchHttpClient } from "effect/http";
import { remoteCommandsFor, sendingShell } from "../../../src/remote/commands.ts";
import { boxdDriverFor, execCredential } from "../../../src/ssh/provisioner/boxd.ts";
import { BoxdApi } from "../../../src/ssh/provisioner/boxd/client.ts";
import { boxdExecLayer } from "../../../src/ssh/provisioner/boxd/exec.ts";
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
  "creates a boxd machine with its egress allowlist, runs a command and a variable over stdin through Exec, and destroys it",
  () =>
    Effect.gen(function* () {
      if (Option.isNone(environment.token) || Option.isNone(environment.snapshot)) return;
      const egress = ["*.tailscale.com", "registry.npmjs.org"].map((entry) =>
        BoxdEgressEntry.make(entry),
      );
      const settings = boxdSettings({
        token: environment.token.value,
        snapshot: BoxdSnapshotName.make(environment.snapshot.value),
        egress: Option.some(egress),
      });
      const now = yield* Clock.currentTimeMillis;
      const suffix = (yield* Random.nextIntBetween(0, 2 ** 32)).toString(16);
      const run = RunId.make(`boxd-live-${now}`);
      yield* Effect.gen(function* () {
        const api = yield* BoxdApi;
        const driver = yield* boxdDriverFor(WorkerName.make("boxd-live"), settings).pipe(
          Effect.provide(boxdExecLayer(api.endpoint, execCredential(settings))),
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
              const machine = yield* api.vm(id);
              assert.sameMembers([...machine.egressAllow], egress, "GetVm reports the allowlist");
              const endpoint = yield* driver
                .endpoint(id, Effect.sleep("100 millis"))
                .pipe(Effect.timeout("2 minutes"));
              assert(endpoint._tag === "Exec");
              const commands = yield* remoteCommandsFor;
              const base = ExecShell.make({
                transport: endpoint.transport,
                destination: endpoint.machine,
              });
              const answered = yield* commands
                .run("preflight", base, "true", [])
                .pipe(
                  Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 20 }),
                  Effect.timeout("1 minute"),
                );
              assert.strictEqual(answered, "");
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

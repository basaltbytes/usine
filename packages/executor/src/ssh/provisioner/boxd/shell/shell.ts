/**
 * The boxd shell: a stand-in for `ssh` that runs one command on a boxd machine over boxd's gRPC
 * `Exec` stream, under the `SshCommand` contract of `@usine/agents/child-host`. The destination is
 * the machine id. The executor uses it as the `SshCommand` of each boxd machine's `RemoteShell`.
 */
// Imports only light modules: this program starts once per command on a boxd machine.
import { MachineId } from "@usine/core/worker";
import { Config, Effect, Schema, Stream } from "effect";

import { runStandIn, StandInFailure, type StandInStreams } from "../../../../remote/stand-in.ts";
import { BoxdExec, boxdExecLayer } from "../exec.ts";
import { BOXD_SHELL_ENVIRONMENT } from "./environment.ts";

/** Returns the `BoxdExec` for the endpoint and credential in the shell's environment. */
const execLayer = Effect.gen(function* () {
  const endpoint = yield* Config.String(BOXD_SHELL_ENVIRONMENT.endpoint);
  const credential = yield* Config.Redacted(BOXD_SHELL_ENVIRONMENT.credential);
  return boxdExecLayer(endpoint, credential);
}).pipe(
  Effect.mapError(() =>
    StandInFailure.make({
      message: `set ${Object.values(BOXD_SHELL_ENVIRONMENT).join(" and ")} in the environment`,
    }),
  ),
);

/** Runs `line` on `machine` and relays its standard streams; returns its exit code. */
const relay = Effect.fn("BoxdShell.relay")(function* (
  machine: MachineId,
  line: string,
  streams: StandInStreams,
) {
  const exec = yield* BoxdExec;
  const execution = yield* exec.exec(machine, line, streams.stdin);
  const [, , exitCode] = yield* Effect.all(
    [
      Stream.runForEach(execution.stdout, streams.stdout),
      Stream.runForEach(execution.stderr, streams.stderr),
      execution.exitCode,
    ],
    { concurrency: "unbounded" },
  );
  return exitCode;
}, Effect.scoped);

runStandIn("usine boxd shell", ({ destination, line }, streams) =>
  Effect.gen(function* () {
    const machine = yield* Schema.decodeEffect(MachineId)(destination).pipe(
      Effect.mapError(() =>
        StandInFailure.make({ message: `invalid boxd machine id ${destination}` }),
      ),
    );
    const layer = yield* execLayer;
    return yield* relay(machine, line, streams).pipe(
      // The program's entry point.
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(layer),
      Effect.catchTags({
        BoxdMachineGone: (gone) =>
          Effect.fail(
            StandInFailure.make({
              message: `boxd machine ${gone.machine} is gone: ${gone.message}`,
            }),
          ),
        BoxdCallError: (failure) =>
          Effect.fail(
            StandInFailure.make({
              message: `boxd exec on ${machine} failed: ${failure.code}: ${failure.message}`,
            }),
          ),
      }),
    );
  }),
);

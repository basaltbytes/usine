import { env } from "node:process";
import { recordedContainerTransport } from "../replay/container.ts";
import { isJsonObject, type Tape } from "../replay/transcript.ts";
import { processTransport } from "../replay/process.ts";
import type { Provider } from "../replay/fixture.ts";
import { assert } from "@effect/vitest";
import { Effect, FileSystem, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { ExecShell } from "../../src/child-host/child-host.ts";
import { SupervisorSeat } from "../../src/harness/supervisor/sandbox.ts";

/** The replay runtime executes fixture commands locally after checking the container invocation. */
export const replayContainerHost = (provider: Provider, tape: Tape) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const live = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "supervisor-runtime-" });
    const recording = tape.source === "record";
    const name = recording ? env.USINE_SUPERVISOR_CONTRACT_CONTAINER : "supervisor-contract";
    assert(name, "Recording supervisor traffic requires USINE_SUPERVISOR_CONTRACT_CONTAINER");
    const runtime = recording
      ? (env.USINE_SUPERVISOR_CONTRACT_RUNTIME ?? "docker")
      : `${directory}/runtime`;
    tape.bind(runtime, "$CONTAINER_RUNTIME");
    tape.bind(name, "$CONTRACT_CONTAINER");
    const launch =
      tape.source === "record"
        ? undefined
        : tape.source.entries.find(
            (entry) => entry.type === "expect_outbound" && entry.port === "process:1",
          );
    const nativeCodexTraffic =
      tape.source !== "record" &&
      tape.source.protocol === "codex-app-server" &&
      launch?.type === "expect_outbound" &&
      isJsonObject(launch.payload) &&
      launch.payload.command !== "sh";
    const spawner =
      provider === "codex"
        ? yield* ChildProcessSpawner.ChildProcessSpawner.pipe(
            Effect.provide(processTransport(tape, recording ? live : undefined)),
          )
        : live;
    if (!recording) {
      yield* fs.writeFileString(
        runtime,
        '#!/bin/sh\n[ "$1" = exec ] && [ "$2" = -i ] && [ "$3" = supervisor-contract ] || exit 125\nshift 3\nexec "$@"\n',
      );
      yield* fs.chmod(runtime, 0o700);
    }
    return yield* Schema.decodeEffect(SupervisorSeat.fields.host)(
      ExecShell.make({
        destination: name,
        container: { runtime, name },
        transport: nativeCodexTraffic
          ? recordedContainerTransport(tape)
          : {
              run: (line, stdin) =>
                Effect.gen(function* () {
                  assert.include(line, "'sh' '-c'");
                  const handle = yield* spawner
                    .spawn(
                      ChildProcess.make("sh", ["-c", line], {
                        stdin: { stream: stdin, endOnDone: true },
                        forceKillAfter: "2 seconds",
                      }),
                    )
                    .pipe(Effect.orDie);
                  return {
                    stdout: handle.stdout.pipe(Stream.orDie),
                    stderr: handle.stderr.pipe(Stream.orDie),
                    exitCode: handle.exitCode.pipe(Effect.map(Number), Effect.orDie),
                  };
                }),
            },
      }),
    ).pipe(Effect.orDie);
  });

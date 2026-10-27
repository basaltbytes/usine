import { Effect, Layer, Option, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { assert, describe, it } from "vitest";
import { ProcessId } from "../../src/instance/record.ts";
import {
  SystemctlError,
  SystemdUnit,
  supervisingUnit,
  systemServiceOf,
} from "../../src/instance/systemd.ts";

const unit = SystemdUnit.make("usine.service");

/** Answers every command with `exitCode` and `output`, as a `systemctl` would. */
const systemctl = (exitCode: number, output: string) =>
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
    ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(123),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.make(new TextEncoder().encode(exitCode === 0 ? output : "")),
          stderr: Stream.make(new TextEncoder().encode(exitCode === 0 ? "" : output)),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        }),
      ),
    ),
  );

describe("systemd service detection", () => {
  it("finds the system service of a cgroup, and none for a session or a user's service manager", () => {
    const service = (cgroup: string) => Option.getOrUndefined(systemServiceOf(cgroup));
    assert.strictEqual(service("0::/system.slice/usine.service\n"), "usine.service");
    assert.strictEqual(
      service("0::/system.slice/system-usine.slice/usine@factory.service\n"),
      "usine@factory.service",
    );
    // A user's manager is a system service itself; usine's CLI must not manage it.
    assert.isUndefined(
      service("0::/user.slice/user-1000.slice/user@1000.service/app.slice/usine.service\n"),
    );
    assert.isUndefined(service("0::/user.slice/user-1000.slice/session-3.scope\n"));
    assert.isUndefined(service("0::/init.scope\n"));
    // A container without its own systemd sees its cgroup's root.
    assert.isUndefined(service("0::/\n"));
  });

  it("fails instead of signaling the process when systemctl can't say who the main process is", async () => {
    const pid = ProcessId.make(4242);
    const managed = await Effect.runPromise(
      supervisingUnit(pid, Option.some(unit)).pipe(Effect.provide(systemctl(0, "4242\n"))),
    );
    assert.deepStrictEqual(managed, Option.some(unit));

    // Signals would stop the process behind systemd's back, which then restarts it on failure.
    const error = await Effect.runPromise(
      supervisingUnit(pid, Option.some(unit)).pipe(
        Effect.flip,
        Effect.provide(systemctl(1, "Failed to connect to bus: No such file or directory")),
      ),
    );
    assert.instanceOf(error, SystemctlError);
    assert.strictEqual(error.command, "systemctl show --property=MainPID --value usine.service");
    assert.include(error.reason, "Failed to connect to bus");
  });
});

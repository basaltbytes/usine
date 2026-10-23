import type { RemoteShell } from "@usine/agents/child-host";
import { ClaudeLoginLock } from "@usine/agents/runtime";
import type { BrainSpec } from "@usine/core/agent/brain";
import { SshDestination, WorkerName } from "@usine/core/worker";
import { Effect, Ref, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  ExecutorOperationError,
  logPreflightFailure,
  WorkerCapabilityError,
  type WorkerCapability,
} from "../executor.ts";
import { agentsHarnessProbe, verifyHarnessReadiness } from "../harness-preflight.ts";
import { verifyLinuxMemory } from "../memory-preflight.ts";
import type { ExeDevCommands } from "./commands.ts";
import { HomePath, type ExeDevExecutorOptions, type VmState } from "./model.ts";

const Vm = Schema.Struct({
  vmName: Schema.NonEmptyString,
  sshDest: SshDestination,
  status: Schema.NonEmptyString,
}).pipe(Schema.encodeKeys({ vmName: "vm_name", sshDest: "ssh_dest" }));
const VmList = Schema.Struct({ vms: Schema.Array(Vm) });
const decodeVmList = Schema.decodeUnknownEffect(Schema.fromJsonString(VmList));
const decodeHome = Schema.decodeUnknownEffect(HomePath);

const capabilityError = (
  worker: WorkerName,
  capability: WorkerCapability,
  message: string,
  cause: unknown,
): WorkerCapabilityError => new WorkerCapabilityError({ worker, capability, message, cause });

export const preflightFor = Effect.fn("ExeDevExecutor.preflightFor")(function* (
  options: ExeDevExecutorOptions,
  commands: ExeDevCommands,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const logins = yield* ClaudeLoginLock;
  const workers = yield* Ref.make(new Map<WorkerName, VmState>());

  /** Returns a harness probe that runs on the VM with no extra environment variables. */
  const harnessProbe = (shell: RemoteShell) => agentsHarnessProbe(spawner, shell, {});

  const resolveVm = Effect.fn("ExeDevExecutor.resolveVm")(function* (worker: WorkerName) {
    const response = yield* commands.lobbyJson("preflight", ["ls", worker]);
    const decoded = yield* decodeVmList(response).pipe(
      Effect.mapError((cause) =>
        capabilityError(
          worker,
          "machine",
          `exe.dev returned invalid machine metadata for worker "${worker}"`,
          cause,
        ),
      ),
    );
    const vm = decoded.vms.find(({ vmName }) => vmName === worker);
    if (vm === undefined) {
      return yield* capabilityError(
        worker,
        "machine",
        `exe.dev has no VM named "${worker}"`,
        new Error("worker VM missing"),
      );
    }
    if (vm.status !== "running") {
      return yield* capabilityError(
        worker,
        "machine",
        `exe.dev VM "${worker}" is ${vm.status}, not running`,
        new Error(`VM status: ${vm.status}`),
      );
    }
    const reported = (yield* commands.remote("preflight", vm.sshDest, "printenv", ["HOME"])).trim();
    const home = yield* decodeHome(reported).pipe(
      Effect.mapError((cause) =>
        capabilityError(
          worker,
          "toolchain",
          `exe.dev VM "${worker}" returned an invalid home directory`,
          cause,
        ),
      ),
    );
    return { home, sshDest: vm.sshDest } satisfies VmState;
  });

  const asCapability = <A>(
    worker: WorkerName,
    capability: WorkerCapability,
    message: string,
    effect: Effect.Effect<A, ExecutorOperationError>,
  ): Effect.Effect<A, WorkerCapabilityError> =>
    effect.pipe(Effect.mapError((cause) => capabilityError(worker, capability, message, cause)));

  const preflight = Effect.fn("ExeDevExecutor.preflight")(function* (
    worker: WorkerName,
    brains: ReadonlyArray<BrainSpec>,
    maxConcurrentAttempts: number,
  ) {
    const vm = yield* resolveVm(worker).pipe(
      Effect.catchTag("ExecutorOperationError", (cause) =>
        capabilityError(worker, "machine", `Can't reach exe.dev worker "${worker}"`, cause),
      ),
    );
    yield* Effect.annotateCurrentSpan({ worker, host: vm.sshDest });
    const gitVersion = (yield* asCapability(
      worker,
      "toolchain",
      `Worker "${worker}" can't run Git`,
      commands.remote("preflight", vm.sshDest, "git", ["--version"]),
    )).trim();
    if (!gitVersion.startsWith("git version ")) {
      return yield* capabilityError(
        worker,
        "toolchain",
        `Worker "${worker}" returned an unrecognized Git version`,
        new Error(gitVersion),
      );
    }
    yield* verifyLinuxMemory(
      worker,
      maxConcurrentAttempts,
      commands.remote("preflight", vm.sshDest, "cat", ["/proc/meminfo"]),
    );

    yield* verifyHarnessReadiness(
      worker,
      brains,
      harnessProbe(commands.childHost(vm.sshDest)),
      logins,
    );

    for (const integration of options.githubIntegrations) {
      yield* asCapability(
        worker,
        "credentials",
        `exe.dev GitHub integration "${integration.name}" isn't ready for ${integration.repository}`,
        commands.lobby("preflight", ["integrations", "test", integration.name]),
      );
    }

    yield* Ref.update(workers, (current) => {
      const next = new Map(current);
      next.set(worker, vm);
      return next;
    });
    yield* Effect.logInfo("exe.dev Worker preflight verified", {
      worker,
      host: vm.sshDest,
      gitVersion,
      harnesses: [...new Set(brains.map(({ harness }) => harness))].join(","),
      integrations: options.githubIntegrations.length,
    });
  }, logPreflightFailure);

  const vmFor = Effect.fn("ExeDevExecutor.vmFor")(function* (worker: WorkerName) {
    const cached = (yield* Ref.get(workers)).get(worker);
    if (cached !== undefined) return cached;
    return yield* resolveVm(worker);
  });

  return { preflight, vmFor, harnessProbe };
});

import { AttemptChannel, Worker } from "@usine/core";
import { Effect, Ref, Schema } from "effect";
import {
  ExecutorOperationError,
  logPreflightFailure,
  type RunHostCommand,
  WorkerCapabilityError,
  type WorkerCapability,
} from "../index.ts";
import type { ExeDevCommands } from "./commands.ts";
import { HomePath, SshDestination, type ExeDevExecutorOptions, type VmState } from "./model.ts";

const MINIMUM_NODE_MAJOR = 22;

const Vm = Schema.Struct({
  vmName: Schema.NonEmptyString,
  sshDest: SshDestination,
  status: Schema.NonEmptyString,
}).pipe(Schema.encodeKeys({ vmName: "vm_name", sshDest: "ssh_dest" }));
const VmList = Schema.Struct({ vms: Schema.Array(Vm) });
const decodeVmList = Schema.decodeUnknownEffect(Schema.fromJsonString(VmList));
const decodeHome = Schema.decodeUnknownEffect(HomePath);

const capabilityError = (
  worker: Worker.Name,
  capability: WorkerCapability,
  message: string,
  cause: unknown,
): WorkerCapabilityError => new WorkerCapabilityError({ worker, capability, message, cause });

export const preflightFor = Effect.fn("ExeDevExecutor.preflightFor")(function* (
  options: ExeDevExecutorOptions,
  commands: ExeDevCommands,
  runHost: RunHostCommand,
) {
  const workers = yield* Ref.make(new Map<Worker.Name, VmState>());

  const resolveVm = Effect.fn("ExeDevExecutor.resolveVm")(function* (worker: Worker.Name) {
    const response = yield* commands.lobbyJson("preflight", ["ls", worker]);
    const decoded = yield* decodeVmList(response).pipe(
      Effect.mapError((cause) =>
        capabilityError(
          worker,
          "machine",
          `exe.dev returned invalid machine metadata for Worker ${worker}`,
          cause,
        ),
      ),
    );
    const vm = decoded.vms.find(({ vmName }) => vmName === worker);
    if (vm === undefined) {
      return yield* capabilityError(
        worker,
        "machine",
        `exe.dev has no VM named ${worker}`,
        new Error("worker VM missing"),
      );
    }
    if (vm.status !== "running") {
      return yield* capabilityError(
        worker,
        "machine",
        `exe.dev VM ${worker} is ${vm.status}, not running`,
        new Error(`VM status: ${vm.status}`),
      );
    }
    const reported = (yield* commands.remote("preflight", vm.sshDest, "printenv", ["HOME"])).trim();
    const home = yield* decodeHome(reported).pipe(
      Effect.mapError((cause) =>
        capabilityError(
          worker,
          "toolchain",
          `exe.dev VM ${worker} returned an invalid home directory`,
          cause,
        ),
      ),
    );
    return { home, sshDest: vm.sshDest } satisfies VmState;
  });

  const asCapability = <A>(
    worker: Worker.Name,
    capability: WorkerCapability,
    message: string,
    effect: Effect.Effect<A, ExecutorOperationError>,
  ): Effect.Effect<A, WorkerCapabilityError> =>
    effect.pipe(Effect.mapError((cause) => capabilityError(worker, capability, message, cause)));

  const preflight = Effect.fn("ExeDevExecutor.preflight")(function* (worker: Worker.Name) {
    const vm = yield* resolveVm(worker).pipe(
      Effect.catchTag("ExecutorOperationError", (cause) =>
        capabilityError(worker, "machine", `Could not reach exe.dev Worker ${worker}`, cause),
      ),
    );
    yield* Effect.annotateCurrentSpan({ worker, host: vm.sshDest });
    const gitVersion = (yield* asCapability(
      worker,
      "toolchain",
      `Worker ${worker} cannot run Git`,
      commands.remote("preflight", vm.sshDest, "git", ["--version"]),
    )).trim();
    if (!gitVersion.startsWith("git version ")) {
      return yield* capabilityError(
        worker,
        "toolchain",
        `Worker ${worker} returned an unrecognized Git version`,
        new Error(gitVersion),
      );
    }

    const nodeVersion = (yield* asCapability(
      worker,
      "toolchain",
      `Worker ${worker} cannot run Node.js`,
      commands.remote("preflight", vm.sshDest, "node", ["--version"]),
    )).trim();
    const nodeMajor = Number(/^v(?<major>\d+)/u.exec(nodeVersion)?.groups?.major ?? Number.NaN);
    if (!Number.isSafeInteger(nodeMajor) || nodeMajor < MINIMUM_NODE_MAJOR) {
      return yield* capabilityError(
        worker,
        "toolchain",
        `Worker ${worker} has Node.js ${nodeVersion || "unknown"}; expected ${MINIMUM_NODE_MAJOR}+`,
        new Error("Node.js version mismatch"),
      );
    }

    const protocol = (yield* asCapability(
      worker,
      "run-host",
      `Worker ${worker} cannot run ${runHost.command}`,
      commands.remote("preflight", vm.sshDest, runHost.command, [
        ...runHost.args,
        "--protocol-version",
      ]),
    )).trim();
    if (protocol !== String(AttemptChannel.PROTOCOL_VERSION)) {
      return yield* capabilityError(
        worker,
        "run-host",
        `Worker ${worker} has run-host protocol ${protocol || "unknown"}; expected ${AttemptChannel.PROTOCOL_VERSION}`,
        new Error("run-host protocol mismatch"),
      );
    }

    for (const check of options.harnessLoginChecks) {
      yield* asCapability(
        worker,
        "harness-login",
        `${check.harness} is not logged in on Worker ${worker}`,
        commands.remote("preflight", vm.sshDest, check.command, check.args),
      );
    }

    for (const integration of options.githubIntegrations) {
      yield* asCapability(
        worker,
        "credentials",
        `exe.dev GitHub integration ${integration.name} is not ready for ${integration.repository}`,
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
      nodeVersion,
      protocolVersion: AttemptChannel.PROTOCOL_VERSION,
      harnesses: options.harnessLoginChecks.map(({ harness }) => harness).join(","),
      integrations: options.githubIntegrations.length,
    });
  }, logPreflightFailure);

  // Both resolveVm failures sit inside the ExecutorError union prepare
  // reports, so a stopped VM keeps its typed capability shape.
  const vmFor = Effect.fn("ExeDevExecutor.vmFor")(function* (worker: Worker.Name) {
    const cached = (yield* Ref.get(workers)).get(worker);
    if (cached !== undefined) return cached;
    return yield* resolveVm(worker);
  });

  return { preflight, vmFor };
});

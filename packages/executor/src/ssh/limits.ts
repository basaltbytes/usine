import {
  CONTAINER_LIMITS,
  ContainerCpus,
  type ContainerLimit,
  ContainerLimits,
  ContainerMemoryMib,
  ContainerPids,
} from "@usine/core/worker";
import { Match, Option, Schema } from "effect";
import { memoryFromMeminfo } from "../memory-preflight.ts";
import type { SshWorkerContainer } from "./model.ts";

const MIB = 1024 ** 2;

/** What a Linux machine's kernel reports of its CPUs, memory, and tasks. */
export class MachineResources extends Schema.Class<MachineResources>(
  "@usine/executor/MachineResources",
)({
  /** The CPUs available to the SSH user, as `nproc` counts them. */
  cpus: Schema.Int.check(Schema.isGreaterThan(0)),
  memoryBytes: Schema.Int.check(Schema.isGreaterThan(0)),
  /** The most processes and threads the kernel runs at once: the lower of `threads-max` and `pid_max`. */
  tasks: Schema.Int.check(Schema.isGreaterThan(0)),
}) {}

/**
 * A script that prints the number of CPUs, the kernel's `threads-max` and `pid_max`, and
 * `/proc/meminfo`.
 */
export const RESOURCES_SCRIPT =
  "nproc && cat /proc/sys/kernel/threads-max /proc/sys/kernel/pid_max /proc/meminfo";

const decodeResources = Schema.decodeUnknownOption(MachineResources);

/** Parses the output of `RESOURCES_SCRIPT`. Returns `None` if a value is missing or not a positive integer. */
export const resourcesFromOutput = (output: string): Option.Option<MachineResources> => {
  const [cpus, threadsMax, pidMax, ...meminfo] = output.split("\n");
  return Option.flatMap(memoryFromMeminfo(meminfo.join("\n")), ({ totalBytes }) =>
    decodeResources({
      cpus: Number(cpus),
      memoryBytes: totalBytes,
      tasks: Math.min(Number(threadsMax), Number(pidMax)),
    }),
  );
};

/** What the Attempt containers leave to the machine's own processes, such as sshd, Docker, and the cached clones' fetches. */
export const HOST_MEMORY_RESERVE_MIB = 1024;
const HOST_RESERVE = { memoryMib: HOST_MEMORY_RESERVE_MIB, tasks: 1024 } as const;

/** The smallest limits that `usine.yaml` and Docker accept. */
const SMALLEST = { cpus: 0.01, memoryMib: 256, pids: 64 } as const;

/**
 * Returns the limits of each container when `slots` Attempts run on `machine` at once: the
 * machine's CPUs and its memory and tasks less their host reserves, divided by `slots`. Rounds
 * down to a hundredth of a CPU, a MiB, and a task, with Docker's minimum limits as a floor.
 */
const deriveLimits = (machine: MachineResources, slots: number): ContainerLimits =>
  new ContainerLimits({
    cpus: ContainerCpus.make(
      Math.max(SMALLEST.cpus, Math.floor((machine.cpus / slots) * 100) / 100),
    ),
    memoryMib: ContainerMemoryMib.make(
      Math.max(
        SMALLEST.memoryMib,
        Math.floor((machine.memoryBytes / MIB - HOST_RESERVE.memoryMib) / slots),
      ),
    ),
    pids: ContainerPids.make(
      Math.max(SMALLEST.pids, Math.floor((machine.tasks - HOST_RESERVE.tasks) / slots)),
    ),
  });

/** The limits of a Worker's containers and where they come from. */
export type ResolvedLimits =
  /** `usine.yaml` sets every limit. */
  | { readonly _tag: "Configured"; readonly limits: ContainerLimits }
  /** `derived` come from `machine` for `slots` concurrent Attempts; `usine.yaml` sets the others. */
  | {
      readonly _tag: "Derived";
      readonly limits: ContainerLimits;
      readonly derived: ReadonlyArray<ContainerLimit>;
      readonly machine: MachineResources;
      readonly slots: number;
    };

/** Returns the limits of `container` if `usine.yaml` sets every one, or `None`. */
export const configuredLimits = (container: SshWorkerContainer): Option.Option<ResolvedLimits> =>
  Option.map(
    Option.all({ cpus: container.cpus, memoryMib: container.memoryMib, pids: container.pids }),
    (limits) => ({ _tag: "Configured", limits: new ContainerLimits(limits) }),
  );

/**
 * Returns the limits of `container` when `slots` Attempts run on `machine` at once: the ones
 * `usine.yaml` sets, and the others from `deriveLimits`.
 */
export const resolveLimits = (
  container: SshWorkerContainer,
  machine: MachineResources,
  slots: number,
): ResolvedLimits => {
  const derived = deriveLimits(machine, slots);
  const unset = {
    cpus: Option.isNone(container.cpus),
    memoryMib: Option.isNone(container.memoryMib),
    pids: Option.isNone(container.pids),
  } satisfies Record<ContainerLimit, boolean>;
  return {
    _tag: "Derived",
    limits: new ContainerLimits({
      cpus: Option.getOrElse(container.cpus, () => derived.cpus),
      memoryMib: Option.getOrElse(container.memoryMib, () => derived.memoryMib),
      pids: Option.getOrElse(container.pids, () => derived.pids),
    }),
    derived: CONTAINER_LIMITS.filter((limit) => unset[limit]),
    machine,
    slots,
  };
};

/** Returns the log fields of the limits of a Worker's containers. */
export const limitFields = (resolved: ResolvedLimits) => ({
  cpus: resolved.limits.cpus,
  memoryMib: resolved.limits.memoryMib,
  pids: resolved.limits.pids,
  ...Match.valueTags(resolved, {
    Configured: () => ({ derivedLimits: "none" }),
    Derived: ({ derived, machine, slots }) => ({
      derivedLimits: derived.join(","),
      slots,
      machineCpus: machine.cpus,
      machineMemoryMib: Math.floor(machine.memoryBytes / MIB),
      machineTasks: machine.tasks,
    }),
  }),
});

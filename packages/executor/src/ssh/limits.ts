import {
  ContainerCpus,
  ContainerLimits,
  ContainerMemoryMib,
  ContainerPids,
} from "@usine/core/worker";
import { Option, Schema } from "effect";
import { memoryFromMeminfo } from "../memory-preflight.ts";

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
const HOST_RESERVE = { cpus: 0.5, memoryMib: 1024, tasks: 1024 } as const;

/** The smallest limits that `usine.yaml` and Docker accept. */
const SMALLEST = { cpus: 0.01, memoryMib: 256, pids: 64 } as const;

/**
 * Returns the limits of each container when `slots` Attempts run on `machine` at once: the
 * machine's total less a reserve for its own processes, divided by `slots`, rounded down to a
 * hundredth of a CPU, a MiB, and a task, and no lower than the smallest limits Docker accepts.
 */
export const deriveLimits = (machine: MachineResources, slots: number): ContainerLimits =>
  new ContainerLimits({
    cpus: ContainerCpus.make(
      Math.max(SMALLEST.cpus, Math.floor(((machine.cpus - HOST_RESERVE.cpus) / slots) * 100) / 100),
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

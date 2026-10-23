import type { WorkerName } from "@usine/core/worker";
import { Effect, Match, Option, Schema } from "effect";
import { type ExecutorOperationError, WorkerCapabilityError } from "./executor.ts";

const GIB = 1024 ** 3;

// Two Attempts running the usine monorepo gates on a 4 GB Worker without swap made sshd
// unresponsive (#270).
const MEMORY_PER_ATTEMPT_WARNING = 3 * GIB;
const MEMORY_PER_ATTEMPT_MINIMUM = 1.5 * GIB;

const NoSwap = Schema.TaggedStruct("NoSwap", {});

/** A fixed swap size in bytes, as reported by Linux. */
const SwapSpace = Schema.TaggedStruct("SwapSpace", {
  bytes: Schema.Int.check(Schema.isGreaterThan(0)),
});

/** Swap that the OS allocates on demand, as on macOS. */
export const SwapOnDemand = Schema.TaggedStruct("SwapOnDemand", {});

const WorkerSwap = Schema.Union([NoSwap, SwapSpace, SwapOnDemand]);
type WorkerSwap = typeof WorkerSwap.Type;

export class WorkerMemory extends Schema.Class<WorkerMemory>("@usine/executor/WorkerMemory")({
  totalBytes: Schema.Int.check(Schema.isGreaterThan(0)),
  swap: WorkerSwap,
}) {}

const decodeWorkerMemory = Schema.decodeUnknownOption(WorkerMemory);

const kibibytes = (meminfo: string, pattern: RegExp): Option.Option<number> =>
  Option.map(Option.fromNullishOr(pattern.exec(meminfo)?.[1]), Number);

/** Parses `/proc/meminfo`. Returns `None` if MemTotal or SwapTotal is missing. */
const memoryFromMeminfo = (meminfo: string): Option.Option<WorkerMemory> =>
  Option.flatMap(
    Option.all({
      total: kibibytes(meminfo, /^MemTotal:\s+(\d+) kB$/mu),
      swap: kibibytes(meminfo, /^SwapTotal:\s+(\d+) kB$/mu),
    }),
    ({ total, swap }) =>
      decodeWorkerMemory({
        totalBytes: total * 1024,
        swap: swap === 0 ? NoSwap.make({}) : SwapSpace.make({ bytes: swap * 1024 }),
      }),
  );

const gib = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GiB`;

const swapText = (swap: WorkerSwap): string =>
  Match.valueTags(swap, {
    NoSwap: () => "none",
    SwapSpace: ({ bytes }) => gib(bytes),
    SwapOnDemand: () => "on demand",
  });

const memoryError = (worker: WorkerName, message: string, cause: unknown) =>
  new WorkerCapabilityError({ worker, capability: "memory", message, cause });

/**
 * Checks that `worker`'s machine can run `maxConcurrentAttempts` concurrent Attempts. Fails
 * below 1.5 GiB per Attempt or for more than one Attempt without swap; logs a warning below
 * 3 GiB per Attempt.
 */
export const verifyWorkerMemory = Effect.fn("Executor.verifyWorkerMemory")(function* (
  worker: WorkerName,
  maxConcurrentAttempts: number,
  memory: WorkerMemory,
) {
  const perAttempt = memory.totalBytes / maxConcurrentAttempts;
  const fields = {
    worker,
    maxConcurrentAttempts,
    memory: gib(memory.totalBytes),
    swap: swapText(memory.swap),
    perAttempt: gib(perAttempt),
  };
  yield* Effect.annotateCurrentSpan(fields);
  const withoutSwap = memory.swap._tag === "NoSwap";
  if (perAttempt < MEMORY_PER_ATTEMPT_MINIMUM) {
    const fitting = Math.floor(memory.totalBytes / MEMORY_PER_ATTEMPT_MINIMUM);
    const carried = withoutSwap ? Math.min(fitting, 1) : fitting;
    const advice =
      carried === 0
        ? "give the machine more memory"
        : `set max_concurrent_attempts to ${carried} or less, or give the machine more memory`;
    return yield* memoryError(
      worker,
      `Worker ${worker} has ${gib(memory.totalBytes)} of memory for max_concurrent_attempts: ${maxConcurrentAttempts}, ${gib(perAttempt)} per Attempt, and an Attempt needs at least ${gib(MEMORY_PER_ATTEMPT_MINIMUM)}; ${advice}`,
      memory,
    );
  }
  if (withoutSwap && maxConcurrentAttempts > 1)
    return yield* memoryError(
      worker,
      `Worker ${worker} has no swap for max_concurrent_attempts: ${maxConcurrentAttempts}, and concurrent Attempts without swap can thrash the machine until SSH stops answering; add swap, or set max_concurrent_attempts to 1`,
      memory,
    );
  if (perAttempt < MEMORY_PER_ATTEMPT_WARNING)
    yield* Effect.logWarning(
      `Worker memory is below ${gib(MEMORY_PER_ATTEMPT_WARNING)} per concurrent Attempt`,
      {
        ...fields,
        suggestedMaxConcurrentAttempts: Math.max(
          1,
          Math.floor(memory.totalBytes / MEMORY_PER_ATTEMPT_WARNING),
        ),
      },
    );
  else yield* Effect.logInfo("Worker memory verified", fields);
});

/**
 * Runs `verifyWorkerMemory` for a Linux machine whose `/proc/meminfo` is returned by `meminfo`.
 * Fails if the output lacks MemTotal or SwapTotal.
 */
export const verifyLinuxMemory = Effect.fn("Executor.verifyLinuxMemory")(function* (
  worker: WorkerName,
  maxConcurrentAttempts: number,
  meminfo: Effect.Effect<string, ExecutorOperationError>,
) {
  const output = yield* meminfo.pipe(
    Effect.mapError((cause) =>
      memoryError(worker, `Could not read /proc/meminfo on Worker ${worker}`, cause),
    ),
  );
  const memory = memoryFromMeminfo(output);
  if (Option.isNone(memory))
    return yield* memoryError(
      worker,
      `Worker ${worker} reported no MemTotal or SwapTotal in /proc/meminfo`,
      new Error(output.slice(0, 200)),
    );
  yield* verifyWorkerMemory(worker, maxConcurrentAttempts, memory.value);
});

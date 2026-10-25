import type { InstanceDirectory } from "@usine/core/instance";
import { Effect, Option, Schema } from "effect";
import { lockHeld } from "./lock.ts";
import { InstanceRecord, ProcessId, instanceFiles, readPid, readRecord } from "./record.ts";

/** No process holds the instance lock. */
export class Stopped extends Schema.TaggedClass<Stopped>("@usine/server/InstanceStopped")(
  "Stopped",
  {
    /** The PID that a process left in `.usine/` when it didn't exit cleanly. */
    stale: Schema.Option(ProcessId),
  },
) {}

/** A live process holds the instance lock, and its record names it. */
export class Running extends Schema.TaggedClass<Running>("@usine/server/InstanceRunning")(
  "Running",
  { record: InstanceRecord },
) {}

/**
 * A process holds the instance lock without a record of a live process: a usine version that
 * writes only `.usine/instance.pid`, or a process that is still starting.
 */
export class Unrecorded extends Schema.TaggedClass<Unrecorded>("@usine/server/InstanceUnrecorded")(
  "Unrecorded",
  { pid: Schema.Option(ProcessId) },
) {}

export const InstanceState = Schema.Union([Stopped, Running, Unrecorded]);
export type InstanceState = typeof InstanceState.Type;

/** The process couldn't be signaled, for example because another user owns it. */
export class SignalError extends Schema.TaggedError<SignalError>("@usine/server/SignalError")(
  "SignalError",
  { pid: ProcessId, signal: Schema.String, reason: Schema.String },
) {}

const NoSuchProcess = Schema.Struct({ code: Schema.Literal("ESRCH") });

/** Returns whether a process with the PID exists, including one that another user owns. */
export const processAlive = (pid: ProcessId) =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (cause) {
      return !Schema.is(NoSuchProcess)(cause);
    }
  });

/** Sends `SIGTERM` to the process. Succeeds if the process has already exited. */
export const terminate = Effect.fn("Instance.terminate")(function* (pid: ProcessId) {
  yield* Effect.annotateCurrentSpan({ pid });
  const sent = yield* Effect.try({
    try: () => {
      try {
        return process.kill(pid, "SIGTERM");
      } catch (cause) {
        if (Schema.is(NoSuchProcess)(cause)) return false;
        throw cause;
      }
    },
    catch: (cause) =>
      new SignalError({
        pid,
        signal: "SIGTERM",
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
  });
  yield* sent
    ? Effect.logInfo("Sent SIGTERM to the instance process", { pid })
    : Effect.logInfo("The instance process exited before the signal", { pid });
});

/**
 * Reads whether `usine up` runs in the instance folder. The instance lock decides whether a process
 * runs, so a PID that the OS reused for another process never counts.
 */
export const probeInstance = Effect.fn("Instance.probe")(function* (directory: InstanceDirectory) {
  const files = instanceFiles(directory);
  const record = yield* readRecord(files).pipe(
    Effect.catchTag("InstanceRecordError", (error) =>
      Effect.logWarning("The instance record is unreadable; it is ignored", {
        path: error.path,
        reason: error.reason,
      }).pipe(Effect.as(Option.none<InstanceRecord>())),
    ),
  );
  if (!(yield* lockHeld(files))) {
    const stale = Option.isSome(record) ? Option.some(record.value.pid) : yield* readPid(files);
    return new Stopped({ stale });
  }
  if (Option.isSome(record) && (yield* processAlive(record.value.pid))) {
    return new Running({ record: record.value });
  }
  const pid = yield* readPid(files);
  const live = Option.isSome(pid) && (yield* processAlive(pid.value)) ? pid : Option.none();
  return new Unrecorded({ pid: live });
});

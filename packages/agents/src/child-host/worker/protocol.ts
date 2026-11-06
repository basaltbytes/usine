// The standalone worker parses its wire format without runtime dependencies.
// @effect-diagnostics globalJson:off
/* oxlint-disable usine/no-runtime-typeof -- This module is the standalone worker's JSON parser. */

export type InputFrame = { sequence: number; data: string } | { sequence: number; eof: true };
export type OutputFrame =
  | { stdout: string }
  | { ack: number }
  | { exitCode: number; stderrTail: string };
export interface Checkpoint {
  offset: number;
  skip: number;
}
export type RelayFrame = InputFrame | (Checkpoint & { heartbeat: true; checkpoint: boolean });

const record = (line: string) => {
  const value: unknown = JSON.parse(line);
  if (typeof value !== "object" || value === null) throw new Error("Invalid child process frame");
  return value;
};

export const inputFrame = (line: string): InputFrame => {
  const value = record(line);
  if (
    "sequence" in value &&
    typeof value.sequence === "number" &&
    Number.isSafeInteger(value.sequence)
  ) {
    if ("eof" in value && value.eof === true) return { sequence: value.sequence, eof: true };
    if ("data" in value && typeof value.data === "string")
      return { sequence: value.sequence, data: value.data };
  }
  throw new Error("Invalid child process input frame");
};

export const outputFrame = (line: string): OutputFrame => {
  const value = record(line);
  if ("stdout" in value && typeof value.stdout === "string") return { stdout: value.stdout };
  if ("ack" in value && typeof value.ack === "number" && Number.isSafeInteger(value.ack))
    return { ack: value.ack };
  if (
    "exitCode" in value &&
    typeof value.exitCode === "number" &&
    Number.isSafeInteger(value.exitCode) &&
    "stderrTail" in value &&
    typeof value.stderrTail === "string"
  )
    return { exitCode: value.exitCode, stderrTail: value.stderrTail };
  throw new Error("Invalid child process output frame");
};

export const checkpoint = (line: string): Checkpoint => {
  const value: unknown = JSON.parse(line);
  if (typeof value === "number" && Number.isSafeInteger(value)) return { offset: value, skip: 0 };
  if (
    typeof value === "object" &&
    value !== null &&
    "offset" in value &&
    typeof value.offset === "number" &&
    Number.isSafeInteger(value.offset) &&
    "skip" in value &&
    typeof value.skip === "number" &&
    Number.isSafeInteger(value.skip)
  )
    return { offset: value.offset, skip: value.skip };
  throw new Error("Invalid child process checkpoint");
};

export const relayFrame = (line: string): RelayFrame => {
  const value = record(line);
  if (
    "heartbeat" in value &&
    value.heartbeat === true &&
    "offset" in value &&
    typeof value.offset === "number" &&
    Number.isSafeInteger(value.offset)
  ) {
    const skip = "skip" in value ? value.skip : 0;
    if (typeof skip !== "number" || !Number.isSafeInteger(skip))
      throw new Error("Invalid child process checkpoint");
    return {
      heartbeat: true,
      offset: value.offset,
      skip,
      checkpoint: "checkpoint" in value && value.checkpoint === true,
    };
  }
  return inputFrame(line);
};

export const environmentKeys = (line: string): string[] => {
  const value: unknown = JSON.parse(line);
  if (Array.isArray(value) && value.every((key): key is string => typeof key === "string"))
    return value;
  throw new Error("Invalid child process environment keys");
};

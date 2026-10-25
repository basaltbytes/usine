// Imports Option and Schema alone, not the whole `effect` index: the executor's sandbox shell
// loads this module once per command.
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ProcessId } from "./names.ts";

export {
  ACCESS_CLIENT_ID_HEADER,
  ACCESS_CLIENT_SECRET_HEADER,
  attachPath,
  execPath,
  ProcessId,
  SandboxName,
} from "./names.ts";

/**
 * The first text message of an exec stream. The sandbox runs `command` with `sh -c` as the image's
 * user in its home directory, as sshd runs a remote command line.
 */
export class ExecStart extends Schema.TaggedClass<ExecStart>()("ExecStart", {
  command: Schema.NonEmptyString,
}) {}

/** Closes the command's stdin. Binary messages from the client are its stdin bytes. */
export class StdinEnd extends Schema.TaggedClass<StdinEnd>()("StdinEnd", {}) {}

export const ClientMessage = Schema.Union([ExecStart, StdinEnd]);
export type ClientMessage = typeof ClientMessage.Type;

/** The command started. Its process files are named after `process`. */
export class Started extends Schema.TaggedClass<Started>()("Started", {
  process: ProcessId,
}) {}

/** The command exited with `exitCode`. The stream closes after this message. */
export class Exited extends Schema.TaggedClass<Exited>()("Exited", {
  exitCode: Schema.Int,
}) {}

/**
 * The sandbox can't run or follow the command: no sandbox, a stopped container, or an unknown
 * process. The stream closes after this message.
 */
export class StreamFailed extends Schema.TaggedClass<StreamFailed>()("StreamFailed", {
  message: Schema.String,
}) {}

export const ServerMessage = Schema.Union([Started, Exited, StreamFailed]);
export type ServerMessage = typeof ServerMessage.Type;

export const encodeClientMessage = Schema.encodeSync(Schema.fromJsonString(ClientMessage));
export const decodeClientMessage = Schema.decodeUnknownOption(Schema.fromJsonString(ClientMessage));
export const encodeServerMessage = Schema.encodeSync(Schema.fromJsonString(ServerMessage));
export const decodeServerMessage = Schema.decodeUnknownOption(Schema.fromJsonString(ServerMessage));

/** The command's output stream that a binary server message carries. */
export type OutputChannel = "stdout" | "stderr";

const CHANNEL_BYTES = { stdout: 1, stderr: 2 } as const satisfies Record<OutputChannel, number>;

/** Returns the binary server message with `bytes` of `channel`: one channel byte, then the bytes. */
export const outputFrame = (channel: OutputChannel, bytes: Uint8Array): Uint8Array => {
  const frame = new Uint8Array(bytes.length + 1);
  frame[0] = CHANNEL_BYTES[channel];
  frame.set(bytes, 1);
  return frame;
};

export interface OutputChunk {
  readonly channel: OutputChannel;
  readonly bytes: Uint8Array;
}

/** Returns the channel and bytes of a binary server message, or `None` for an unknown channel byte. */
export const decodeOutputFrame = (frame: Uint8Array): Option.Option<OutputChunk> => {
  const bytes = frame.subarray(1);
  switch (frame[0]) {
    case CHANNEL_BYTES.stdout:
      return Option.some({ channel: "stdout", bytes });
    case CHANNEL_BYTES.stderr:
      return Option.some({ channel: "stderr", bytes });
    default:
      return Option.none();
  }
};

/**
 * The query of an attach stream: the bytes of each output stream the client already has, so the
 * stream resumes after them.
 */
export const AttachOffsets = Schema.Struct({
  stdout: Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  stderr: Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
export type AttachOffsets = typeof AttachOffsets.Type;

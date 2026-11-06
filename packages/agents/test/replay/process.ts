import { assert } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Fiber,
  Layer,
  Predicate,
  PlatformError,
  Result,
  Schema,
  Sink,
  Stream,
} from "effect";
import { Base64 } from "effect/encoding";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { CHILD_LIFELINE } from "../../src/child-host/node.ts";
import { PROCESS_OWNER } from "../../src/child-host/supervisor.ts";
import { Tape } from "./transcript.ts";

const isJsonObject = (value: Schema.Json): value is { readonly [key: string]: Schema.Json } =>
  Predicate.isObject(value);

// Spawn options contain optional fields that JSON omits at this boundary.
// @effect-diagnostics-next-line schemaSync:off
const commandJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
// @effect-diagnostics-next-line schemaSync:off
const parseCommandJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

const encoder = new TextEncoder();
const decodeLine = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));
const encodeLine = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

// Supervisor frames wrap JSON-RPC bytes in base64. Store the decoded bytes so path and token
// redaction also applies inside those frames. Incomplete UTF-8 uses a lossless byte string.
export const decodeWire = (line: string) =>
  Effect.gen(function* () {
    const payload = yield* decodeLine(line).pipe(Effect.orElseSucceed(() => line));
    if (!isJsonObject(payload)) return payload;
    const decoded: Record<string, Schema.Json> = {};
    for (const [key, value] of Object.entries(payload)) {
      if ((key === "data" || key === "stdout" || key === "stderr") && Predicate.isString(value)) {
        const bytes = yield* Effect.fromResult(Base64.decode(value));
        decoded[key] = Result.getOrElse(
          Result.try({
            try: () => ({
              base64: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
            }),
            catch: () => ({
              byteString: Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""),
            }),
          }),
          (raw) => raw,
        );
      } else decoded[key] = value;
    }
    return decoded;
  });
export const encodeWire = (payload: Schema.Json) => {
  if (Predicate.isString(payload)) return Effect.succeed(payload);
  if (!isJsonObject(payload)) return encodeLine(payload);
  return encodeLine(
    Object.fromEntries(
      Object.entries(payload).map(([key, value]) =>
        isJsonObject(value) && Predicate.isString(value.base64)
          ? [key, Base64.encode(encoder.encode(value.base64))]
          : isJsonObject(value) && Predicate.isString(value.byteString)
            ? [key, Base64.encode(Uint8Array.from(value.byteString, (char) => char.charCodeAt(0)))]
            : [key, value],
      ),
    ),
  );
};

export const processTransport = (
  tape: Tape,
  live?: ChildProcessSpawner.ChildProcessSpawner["Service"],
  fault: "early-exit" | "none" = "none",
) =>
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        assert(command._tag === "StandardCommand");
        const port = tape.port("process");
        tape.bind(process.execPath, "$NODE");
        tape.bind(CHILD_LIFELINE, "$CHILD_LIFELINE");
        tape.bind("'" + PROCESS_OWNER.replaceAll("'", `'"'"'`) + "'", "'$PROCESS_OWNER'");
        tape.outbound(
          port,
          parseCommandJson(
            commandJson({
              command: command.command,
              args: command.args,
              cwd: command.options.cwd,
              env: command.options.env,
            }),
          ),
        );
        const stdin = command.options.stdin;
        const hasInput = Predicate.hasProperty(stdin, "stream") && Stream.isStream(stdin.stream);
        const input = hasInput
          ? stdin.stream.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.mapEffect((line) =>
                decodeWire(line).pipe(
                  Effect.orDie,
                  Effect.tap((payload) =>
                    Effect.sync(() => {
                      if (!(isJsonObject(payload) && payload.heartbeat === true))
                        tape.outbound(`${port}/stdin`, payload);
                    }),
                  ),
                  Effect.as(encoder.encode(`${line}\n`)),
                ),
              ),
              Stream.onEnd(Effect.sync(() => tape.outbound(`${port}/stdin`, { eof: true }))),
            )
          : Stream.empty;
        if (live !== undefined) {
          const options = hasInput
            ? {
                ...command.options,
                stdin: { stream: input, endOnDone: stdin.endOnDone },
              }
            : command.options;
          const handle = yield* live.spawn(
            ChildProcess.make(command.command, command.args, options),
          );
          if (fault === "early-exit") process.kill(handle.pid, "SIGKILL");
          const exitCode = yield* Effect.cached(
            handle.exitCode.pipe(
              Effect.tap((code) => Effect.sync(() => tape.exit(`${port}/exit`, code, null))),
              Effect.tapError((error) =>
                Effect.sync(() => tape.exit(`${port}/exit`, null, error.message)),
              ),
            ),
          );
          return ChildProcessSpawner.makeHandle({
            ...handle,
            exitCode,
            stdout: handle.stdout.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.tap((line) =>
                decodeWire(line).pipe(
                  Effect.tap((payload) =>
                    Effect.sync(() => tape.inbound(`${port}/stdout`, payload)),
                  ),
                  Effect.orDie,
                ),
              ),
              Stream.map((line) => encoder.encode(`${line}\n`)),
              Stream.onEnd(Effect.sync(() => tape.exit(`${port}/stdout`, 0, null))),
            ),
          });
        }
        const exited = yield* Deferred.make<
          ChildProcessSpawner.ExitCode,
          PlatformError.PlatformError
        >();
        const feeding = hasInput
          ? yield* input.pipe(Stream.runDrain, Effect.forkScoped)
          : undefined;
        yield* Effect.promise(() => tape.read(`${port}/exit`)).pipe(
          Effect.tap(() => (feeding === undefined ? Effect.void : Fiber.interrupt(feeding))),
          Effect.flatMap((entry) => {
            assert(entry.type === "runtime_exit");
            if (entry.error !== null)
              return Deferred.fail(
                exited,
                PlatformError.systemError({
                  _tag: "Unknown",
                  module: "ChildProcessSpawner",
                  method: "exitCode",
                  description: entry.error,
                }),
              );
            assert(entry.code !== null);
            return Deferred.succeed(exited, ChildProcessSpawner.ExitCode(entry.code));
          }),
          Effect.forkScoped,
        );
        const stdout = Stream.fromEffectRepeat(
          Effect.promise(() => tape.read(`${port}/stdout`)),
        ).pipe(
          Stream.takeWhile((entry) => entry.type !== "runtime_exit"),
          Stream.mapEffect((entry) => {
            assert(entry.type === "emit_inbound");
            return encodeWire(entry.payload).pipe(
              Effect.orDie,
              Effect.map((line) => encoder.encode(`${line}\n`)),
            );
          }),
        );
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(4242),
          exitCode: Deferred.await(exited),
          isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    ),
  );

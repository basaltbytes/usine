/**
 * The sandbox shell: a stand-in for `ssh` that runs one command in a Cloudflare sandbox through
 * the Worker's exec stream, under the `SshCommand` contract of `@usine/agents/child-host`. The
 * executor uses it as a `RemoteShell`'s SSH command, so children and git commands run in a sandbox
 * as they run over SSH. The destination is the sandbox name.
 *
 * If the stream drops after the command started, it attaches to the command's output from the
 * bytes it already wrote, a few times, so a short network failure doesn't lose an exit code. The
 * command's stdin is closed at that point, as it is when an SSH connection drops.
 */
// Imports only light modules: this program starts once per command in a sandbox.
import {
  ACCESS_CLIENT_ID_HEADER,
  ACCESS_CLIENT_SECRET_HEADER,
  attachPath,
  decodeOutputFrame,
  decodeServerMessage,
  encodeClientMessage,
  ExecStart,
  execPath,
  type OutputChannel,
  type ProcessId,
  SandboxName,
  StdinEnd,
} from "@usine/cloudflare/stream";
import { Data, Deferred, Effect, Option, Queue, Schema, Stream } from "effect";

import { runStandIn, StandInFailure, type StandInStreams } from "../../remote/stand-in.ts";
import { SHELL_ENVIRONMENT } from "./environment.ts";

const Settings = Schema.Struct({
  [SHELL_ENVIRONMENT.workerUrl]: Schema.URLFromString,
  [SHELL_ENVIRONMENT.accessClientId]: Schema.NonEmptyString,
  [SHELL_ENVIRONMENT.accessClientSecret]: Schema.NonEmptyString,
});

/** The delays before each attach to a command whose stream dropped. */
const REATTACH_DELAYS = ["500 millis", "1 second", "2 seconds", "4 seconds", "8 seconds"] as const;
/** The time a stream has to open. */
const OPEN_TIMEOUT = "30 seconds";

type Outcome = Data.TaggedEnum<{
  Exited: { readonly exitCode: number };
  Failed: { readonly message: string };
  Dropped: { readonly process: Option.Option<ProcessId>; readonly reason: string };
}>;
const Outcome = Data.taggedEnum<Outcome>();

/** What one exec or attach stream reports, in order. */
type StreamEvent = Data.TaggedEnum<{
  Output: { readonly channel: OutputChannel; readonly bytes: Uint8Array };
  Ended: { readonly outcome: Outcome };
}>;
const StreamEvent = Data.taggedEnum<StreamEvent>();

interface WebSocketInit {
  readonly headers: Readonly<Record<string, string>>;
}

const openSocket = (url: URL, init: WebSocketInit): WebSocket =>
  // SAFETY: Node.js's global WebSocket (undici) takes a WebSocketInit with headers as its second
  // argument from Node.js 22; lib.dom's declaration lists only subprotocols there.
  new WebSocket(url, init as never);

/**
 * Returns the events of one exec or attach stream at `url`, ending with `Ended`. For an exec
 * stream, `start` is the command line, and `stdin` goes to the command once the stream opens, then
 * `StdinEnd`. Ending the returned stream closes the socket and stops reading stdin.
 */
const streamEvents = (
  url: URL,
  init: WebSocketInit,
  start: Option.Option<{ readonly line: string; readonly stdin: Stream.Stream<Uint8Array> }>,
) =>
  Stream.callback<StreamEvent>((queue) =>
    Effect.gen(function* () {
      const socket = yield* Effect.acquireRelease(
        Effect.sync(() => openSocket(new URL(url.href.replace(/^http/u, "ws")), init)),
        (socket) => Effect.sync(() => socket.close()),
      );
      socket.binaryType = "arraybuffer";
      const end = (outcome: Outcome) => {
        Queue.offerUnsafe(queue, StreamEvent.Ended({ outcome }));
        Queue.endUnsafe(queue);
      };
      let process_: Option.Option<ProcessId> = Option.none();
      const opened = yield* Deferred.make<void>();
      socket.addEventListener("open", () => Deferred.doneUnsafe(opened, Effect.void));
      socket.addEventListener("message", (event) => {
        if (event.data instanceof ArrayBuffer) {
          Option.map(decodeOutputFrame(new Uint8Array(event.data)), ({ channel, bytes }) =>
            Queue.offerUnsafe(queue, StreamEvent.Output({ channel, bytes })),
          );
          return;
        }
        Option.map(decodeServerMessage(String(event.data)), (message) => {
          switch (message._tag) {
            case "Started":
              process_ = Option.some(message.process);
              return;
            case "Exited":
              return end(Outcome.Exited({ exitCode: message.exitCode }));
            case "StreamFailed":
              return end(Outcome.Failed({ message: message.message }));
          }
        });
      });
      socket.addEventListener("close", (event) =>
        end(
          Outcome.Dropped({
            process: process_,
            reason: `the stream closed with code ${String(event.code)}`,
          }),
        ),
      );
      socket.addEventListener("error", () =>
        end(Outcome.Dropped({ process: process_, reason: "the stream failed" })),
      );
      const open = yield* Deferred.await(opened).pipe(Effect.timeoutOption(OPEN_TIMEOUT));
      if (Option.isNone(open))
        return end(
          Outcome.Dropped({ process: process_, reason: "the stream didn't open in time" }),
        );
      if (Option.isNone(start)) return;
      socket.send(encodeClientMessage(ExecStart.make({ command: start.value.line })));
      yield* start.value.stdin.pipe(
        Stream.runForEach((chunk) => Effect.sync(() => socket.send(new Uint8Array(chunk)))),
        Effect.andThen(Effect.sync(() => socket.send(encodeClientMessage(StdinEnd.make())))),
        Effect.forkScoped,
      );
    }),
  );

/** Relays one stream's output to the shell's own, and returns how it ended. */
const follow = (
  events: Stream.Stream<StreamEvent>,
  streams: StandInStreams,
  written: Record<OutputChannel, number>,
) =>
  events.pipe(
    Stream.runFoldEffect(
      (): Outcome => Outcome.Dropped({ process: Option.none(), reason: "the stream ended" }),
      (outcome, event) =>
        StreamEvent.$match(event, {
          Output: ({ channel, bytes }) => {
            written[channel] += bytes.length;
            return streams[channel](bytes).pipe(Effect.as(outcome));
          },
          Ended: (ended) => Effect.succeed(ended.outcome),
        }),
    ),
  );

runStandIn("usine sandbox shell", ({ destination, line }, streams) =>
  Effect.gen(function* () {
    const name = yield* Schema.decodeEffect(SandboxName)(destination).pipe(
      Effect.mapError(() =>
        StandInFailure.make({ message: `invalid sandbox name ${destination}` }),
      ),
    );
    const settings = yield* Schema.decodeUnknownEffect(Settings)(process.env).pipe(
      Effect.mapError(() =>
        StandInFailure.make({
          message: `set ${Object.values(SHELL_ENVIRONMENT).join(", ")} in the environment`,
        }),
      ),
    );
    const worker = settings[SHELL_ENVIRONMENT.workerUrl];
    const init = {
      headers: {
        [ACCESS_CLIENT_ID_HEADER]: settings[SHELL_ENVIRONMENT.accessClientId],
        [ACCESS_CLIENT_SECRET_HEADER]: settings[SHELL_ENVIRONMENT.accessClientSecret],
      },
    };
    const written = { stdout: 0, stderr: 0 };
    let outcome = yield* follow(
      streamEvents(
        new URL(execPath(name), worker),
        init,
        Option.some({ line, stdin: streams.stdin }),
      ),
      streams,
      written,
    );
    for (const delay of REATTACH_DELAYS) {
      if (outcome._tag !== "Dropped" || Option.isNone(outcome.process)) break;
      const process = outcome.process.value;
      yield* Effect.sleep(delay);
      const url = new URL(attachPath(name, process), worker);
      url.searchParams.set("stdout", String(written.stdout));
      url.searchParams.set("stderr", String(written.stderr));
      const attached = yield* follow(streamEvents(url, init, Option.none()), streams, written);
      outcome =
        attached._tag === "Dropped" ? { ...attached, process: Option.some(process) } : attached;
    }
    return yield* Outcome.$match(outcome, {
      Exited: ({ exitCode }) => Effect.succeed(exitCode),
      Failed: ({ message }) => Effect.fail(StandInFailure.make({ message })),
      Dropped: ({ reason }) =>
        Effect.fail(StandInFailure.make({ message: `lost sandbox ${name}: ${reason}` })),
    });
  }),
);

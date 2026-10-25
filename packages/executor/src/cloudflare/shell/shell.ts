/**
 * The sandbox shell: a stand-in for `ssh` that runs one command in a Cloudflare sandbox through
 * the Worker's exec stream. It takes an SSH client's arguments, `[options] <sandbox> -- <command>`,
 * relays stdin, stdout, and stderr, and exits with the command's exit code, or 255 if it can't
 * reach the sandbox or follow the command. The executor uses it as a `RemoteShell`'s SSH command,
 * so children and git commands run in a sandbox as they run over SSH.
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
  type ProcessId,
  SandboxName,
  StdinEnd,
} from "@usine/cloudflare/stream";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { SHELL_ENVIRONMENT, SHELL_FAILURE } from "./environment.ts";

const Settings = Schema.Struct({
  [SHELL_ENVIRONMENT.workerUrl]: Schema.URLFromString,
  [SHELL_ENVIRONMENT.accessClientId]: Schema.NonEmptyString,
  [SHELL_ENVIRONMENT.accessClientSecret]: Schema.NonEmptyString,
});

/** The delays before each attach to a command whose stream dropped, in milliseconds. */
const REATTACH_DELAYS = [500, 1_000, 2_000, 4_000, 8_000] as const;
/** The time a stream has to open, in milliseconds. */
const OPEN_TIMEOUT = 30_000;

type Outcome =
  | { readonly _tag: "Exited"; readonly exitCode: number }
  | { readonly _tag: "Failed"; readonly message: string }
  | {
      readonly _tag: "Dropped";
      readonly process: Option.Option<ProcessId>;
      readonly reason: string;
    };

interface WebSocketInit {
  readonly headers: Readonly<Record<string, string>>;
}

const openSocket = (url: URL, init: WebSocketInit): WebSocket =>
  // SAFETY: Node.js's global WebSocket (undici) takes a WebSocketInit with headers as its second
  // argument from Node.js 22; lib.dom's declaration lists only subprotocols there.
  new WebSocket(url, init as never);

const finish = (code: number, message?: string) => {
  if (message !== undefined) process.stderr.write(`usine sandbox shell: ${message}\n`);
  process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
};

const separator = process.argv.indexOf("--");
const destination = Schema.decodeUnknownOption(SandboxName)(process.argv[separator - 1]);
const command = process.argv[separator + 1];
const settings = Schema.decodeUnknownOption(Settings)(process.env);

if (separator < 0 || Option.isNone(destination) || command === undefined || command === "")
  finish(SHELL_FAILURE, "expected [options] <sandbox> -- <command>");
else if (Option.isNone(settings))
  finish(SHELL_FAILURE, `set ${Object.values(SHELL_ENVIRONMENT).join(", ")} in the environment`);
else {
  const { [SHELL_ENVIRONMENT.workerUrl]: worker } = settings.value;
  const init = {
    headers: {
      [ACCESS_CLIENT_ID_HEADER]: settings.value[SHELL_ENVIRONMENT.accessClientId],
      [ACCESS_CLIENT_SECRET_HEADER]: settings.value[SHELL_ENVIRONMENT.accessClientSecret],
    },
  };
  const written = { stdout: 0, stderr: 0 };
  let stdinOpen = true;
  /**
   * Where stdin goes: buffered until the exec stream opens, then to it. Once that stream ends,
   * stdin is dropped, as a dropped SSH connection drops it.
   */
  let stdinTarget:
    | { readonly _tag: "Buffering"; readonly chunks: Array<Uint8Array<ArrayBuffer>> }
    | { readonly _tag: "Streaming"; readonly socket: WebSocket }
    | { readonly _tag: "Dropped" } = { _tag: "Buffering", chunks: [] };

  process.stdin.on("data", (chunk: Uint8Array) => {
    const bytes = new Uint8Array(chunk);
    if (stdinTarget._tag === "Buffering") stdinTarget.chunks.push(bytes);
    if (stdinTarget._tag === "Streaming") stdinTarget.socket.send(bytes);
  });
  process.stdin.on("end", () => {
    stdinOpen = false;
    if (stdinTarget._tag === "Streaming")
      stdinTarget.socket.send(encodeClientMessage(new StdinEnd()));
  });

  /** Opens one exec or attach stream and resolves when it ends. */
  const stream = (url: URL, start: Option.Option<string>) =>
    new Promise<Outcome>((resolve) => {
      const socket = openSocket(new URL(url.href.replace(/^http/u, "ws")), init);
      socket.binaryType = "arraybuffer";
      let process_: Option.Option<ProcessId> = Option.none();
      let settled = false;
      const settle = (outcome: Outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (start._tag === "Some") stdinTarget = { _tag: "Dropped" };
        resolve(outcome);
        socket.close();
      };
      const timer = setTimeout(
        () =>
          settle({ _tag: "Dropped", process: process_, reason: "the stream didn't open in time" }),
        OPEN_TIMEOUT,
      );
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        Option.match(start, {
          onNone: () => undefined,
          onSome: (line) => {
            socket.send(encodeClientMessage(new ExecStart({ command: line })));
            if (stdinTarget._tag === "Buffering")
              for (const chunk of stdinTarget.chunks) socket.send(chunk);
            stdinTarget = { _tag: "Streaming", socket };
            if (!stdinOpen) socket.send(encodeClientMessage(new StdinEnd()));
          },
        });
      });
      socket.addEventListener("message", (event) => {
        if (event.data instanceof ArrayBuffer) {
          Option.map(decodeOutputFrame(new Uint8Array(event.data)), ({ channel, bytes }) => {
            written[channel] += bytes.length;
            (channel === "stdout" ? process.stdout : process.stderr).write(bytes);
          });
          return;
        }
        Option.map(decodeServerMessage(String(event.data)), (message) => {
          switch (message._tag) {
            case "Started":
              process_ = Option.some(message.process);
              return;
            case "Exited":
              return settle({ _tag: "Exited", exitCode: message.exitCode });
            case "StreamFailed":
              return settle({ _tag: "Failed", message: message.message });
          }
        });
      });
      socket.addEventListener("close", (event) =>
        settle({
          _tag: "Dropped",
          process: process_,
          reason: `the stream closed with code ${String(event.code)}`,
        }),
      );
      socket.addEventListener("error", () =>
        settle({ _tag: "Dropped", process: process_, reason: "the stream failed" }),
      );
    });

  const main = async () => {
    const name = destination.value;
    let outcome = await stream(new URL(execPath(name), worker), Option.some(command));
    for (const delay of REATTACH_DELAYS) {
      if (outcome._tag !== "Dropped" || Option.isNone(outcome.process)) break;
      const process = outcome.process.value;
      await new Promise((resolve) => setTimeout(resolve, delay));
      const url = new URL(attachPath(name, process), worker);
      url.searchParams.set("stdout", String(written.stdout));
      url.searchParams.set("stderr", String(written.stderr));
      const attached = await stream(url, Option.none());
      outcome =
        attached._tag === "Dropped" ? { ...attached, process: Option.some(process) } : attached;
    }
    switch (outcome._tag) {
      case "Exited":
        return finish(outcome.exitCode);
      case "Failed":
        return finish(SHELL_FAILURE, outcome.message);
      case "Dropped":
        return finish(SHELL_FAILURE, `lost sandbox ${name}: ${outcome.reason}`);
    }
  };
  void main();
}

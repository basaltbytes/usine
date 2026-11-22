// This standalone Node entry point relays an OpenCode server over JSON lines on its standard
// streams, without runtime dependencies, and reports its own failures through stderr.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalJson:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics processEnv:off
/* oxlint-disable usine/no-runtime-typeof -- This standalone program parses its JSON lines without Schema. */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { type OutgoingHttpHeaders, request as httpRequest } from "node:http";
import { constants } from "node:os";

type Json = null | boolean | number | string | ReadonlyArray<Json> | JsonObject;
interface JsonObject {
  readonly [key: string]: Json;
}
type RequestId = number | string;
interface Request {
  readonly id: RequestId;
  readonly method: string;
  readonly path: string;
  readonly body?: Json;
}
interface Server {
  readonly host: string;
  readonly port: number;
}
type InputLine =
  | { readonly request: Request }
  | { readonly id: RequestId; readonly invalid: string }
  | { readonly invalid: string };

/** `serve` on a free loopback port, with its warnings on stderr. */
const SERVE_ARGUMENTS = [
  "serve",
  "--stdio",
  "--hostname",
  "127.0.0.1",
  "--port",
  "0",
  "--print-logs",
  "--log-level",
  "warn",
];
/**
 * Milliseconds to wait for `serve`'s remaining output after it exits, and for its exit after its
 * event stream closes.
 */
const GRACE_MS = 1000;
/** Milliseconds to wait for OpenCode's first event once `serve` reports its address. */
const READY_WAIT_MS = 30_000;
/**
 * The most bytes in a line, without its newline, that the bridge reads or writes. It equals
 * `MAX_PROTOCOL_LINE_BYTES` in `child-host/lines.ts`, the longest line that the client reads.
 */
const MAX_LINE_BYTES = 4 * 1024 ** 2;
/** The most bytes of input lines that the bridge holds until OpenCode is ready. */
const MAX_HELD_BYTES = MAX_LINE_BYTES;
/** The characters that the bridge keeps from the start of a line longer than `MAX_LINE_BYTES`. */
const HEAD_LENGTH = 256;

const isObject = (value: Json): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJson = (text: string): { readonly value: Json } | undefined => {
  try {
    // JSON.parse returns a JSON value for a string argument without a reviver.
    const value: Json = JSON.parse(text);
    return { value };
  } catch {
    return undefined;
  }
};

/** Returns `value` when it is a request ID: a string or a safe integer. */
const requestId = (value: Json | undefined): RequestId | undefined =>
  typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value))
    ? value
    : undefined;

const inputLine = (line: string): InputLine => {
  const parsed = parseJson(line);
  if (parsed === undefined) return { invalid: "isn't JSON" };
  if (!isObject(parsed.value)) return { invalid: "isn't a JSON object" };
  const { method, path, body } = parsed.value;
  const id = requestId(parsed.value.id);
  if (id === undefined) return { invalid: "has no request ID" };
  if (typeof method !== "string" || !/^[A-Z]+$/u.test(method))
    return { id, invalid: "has no HTTP method" };
  // Keeps the request target in origin form. The host and port come from serve's ready line.
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//"))
    return { id, invalid: "has no absolute path" };
  return { request: body === undefined ? { id, method, path } : { id, method, path, body } };
};

/**
 * Returns the request ID at the start of `head`, the start of an input line too long to parse. The
 * client writes a request's ID first: `{"id":...`.
 */
const leadingId = (head: string): RequestId | undefined => {
  const token = /^\{"id":(-?\d+|"(?:[^"\\]|\\.)*")[,}]/u.exec(head)?.[1];
  return token === undefined ? undefined : requestId(parseJson(token)?.value);
};

/** Returns whether `host`, an IP address or name from a parsed URL, is a loopback address. */
const isLoopback = (host: string) => host === "::1" || /^127\.\d+\.\d+\.\d+$/u.test(host);

/**
 * Returns the server address in `serve`'s ready line, `{"url": ...}`, or none for another line,
 * including a ready line whose host isn't a loopback address.
 */
const readyLine = (line: string): Server | undefined => {
  const parsed = parseJson(line);
  if (parsed === undefined || !isObject(parsed.value)) return undefined;
  const { url } = parsed.value;
  if (typeof url !== "string" || !URL.canParse(url)) return undefined;
  const address = new URL(url);
  const host = address.hostname.replace(/^\[(.*)\]$/u, "$1");
  if (address.protocol !== "http:" || !isLoopback(host)) return undefined;
  return { host, port: address.port === "" ? 80 : Number(address.port) };
};

/**
 * Returns a reader of text that calls `line` with each line, without its `\n` or `\r\n`, and
 * `overflow` with the size in bytes and the first `HEAD_LENGTH` characters of each line longer than
 * `MAX_LINE_BYTES`. `end` passes on an unfinished last line.
 */
const lineReader = (
  line: (text: string) => void,
  overflow: (bytes: number, head: string) => void,
) => {
  let held = "";
  let bytes = 0;
  const add = (piece: string) => {
    const overflowing = bytes > MAX_LINE_BYTES;
    bytes += Buffer.byteLength(piece);
    if (overflowing) return;
    held += piece;
    if (bytes > MAX_LINE_BYTES) held = held.slice(0, HEAD_LENGTH);
  };
  const complete = () => {
    if (bytes > MAX_LINE_BYTES) overflow(bytes, held);
    else line(held.replace(/\r$/u, ""));
    held = "";
    bytes = 0;
  };
  return {
    push: (text: string) => {
      const pieces = text.split("\n");
      const last = pieces.pop() ?? "";
      for (const piece of pieces) {
        add(piece);
        complete();
      }
      add(last);
    },
    end: () => {
      if (bytes > 0) complete();
    },
  };
};

/** Returns where the value starts in an event-stream `data` line, or none for another line. */
const dataStart = (line: string): number | undefined => {
  if (!line.startsWith("data")) return undefined;
  if (line.length === 4) return 4;
  if (line[4] !== ":") return undefined;
  return line[5] === " " ? 6 : 5;
};

/**
 * Returns a reader of event-stream text that calls `dispatch` with the data of each event, and
 * `oversized` with the size in bytes of each event's data that is longer than `MAX_LINE_BYTES`.
 */
const eventStream = (dispatch: (data: string) => void, oversized: (bytes: number) => void) => {
  const data: Array<string> = [];
  let fields = 0;
  let bytes = 0;
  // Counts a data field of `size` bytes, and the newline that joins it to the previous one.
  const count = (size: number) => {
    bytes += (fields > 0 ? 1 : 0) + size;
    fields += 1;
    if (bytes > MAX_LINE_BYTES) data.length = 0;
  };
  const reader = lineReader(
    (line) => {
      if (line === "") {
        if (bytes > MAX_LINE_BYTES) oversized(bytes);
        else if (fields > 0) dispatch(data.join("\n"));
        data.length = 0;
        fields = 0;
        bytes = 0;
        return;
      }
      const start = dataStart(line);
      if (start === undefined) return;
      const value = line.slice(start);
      count(Buffer.byteLength(value));
      if (bytes <= MAX_LINE_BYTES) data.push(value);
    },
    (lineBytes, head) => {
      const start = dataStart(head);
      if (start !== undefined) count(lineBytes - start);
    },
  );
  return reader.push;
};

/** Returns `value` as an output line, or none when it is longer than `MAX_LINE_BYTES`. */
const outputLine = (value: Json): string | undefined => {
  const text = JSON.stringify(value);
  return Buffer.byteLength(text) > MAX_LINE_BYTES ? undefined : `${text}\n`;
};

/** The answer body: the response's JSON, `null` when it is empty, or its text when it isn't JSON. */
const answerBody = (text: string): Json => {
  if (text === "") return null;
  return parseJson(text)?.value ?? text;
};

const main = () => {
  const [command, ...args] = process.argv.slice(1);
  const warn = (message: string) => {
    process.stderr.write(`opencode bridge: ${message}\n`);
  };
  if (command === undefined) {
    warn("missing the OpenCode command");
    process.exitCode = 2;
    return;
  }
  // The password stays in this process and in serve's environment, which serve clears at start.
  const password = randomBytes(32).toString("base64url");
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  // OpenCode's documentation lets `OPENCODE_SERVER_USERNAME` replace the user name `opencode`.
  const {
    OPENCODE_PASSWORD: _inheritedPassword,
    OPENCODE_SERVER_PASSWORD: _inheritedServerPassword,
    OPENCODE_SERVER_USERNAME: _inheritedUserName,
    ...environment
  } = process.env;
  const serve = spawn(command, [...args, ...SERVE_ARGUMENTS], {
    env: { ...environment, OPENCODE_PASSWORD: password },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let server: Server | undefined;
  let ready = false;
  let closing = false;
  let failed = false;
  let finished = false;
  let readyWait: ReturnType<typeof setTimeout> | undefined;
  const waiting: Array<string> = [];
  let waitingBytes = 0;

  const writeLine = (value: Json) => {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  };
  const finish = (code: number) => {
    if (finished) return;
    finished = true;
    process.exitCode = code;
    process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
  };
  // Ends serve's lease, so that serve exits and the bridge exits with a failure code.
  const fail = (message: string) => {
    if (failed || closing) return;
    failed = true;
    warn(message);
    serve.stdin.end();
  };

  const relay = (target: Server, request: Request) => {
    let answered = false;
    const tooLong: JsonObject = {
      id: request.id,
      error: `OpenCode's response is too long for a line of ${MAX_LINE_BYTES} bytes`,
    };
    const answer = (value: JsonObject) => {
      if (answered) return;
      answered = true;
      process.stdout.write(outputLine(value) ?? `${JSON.stringify(tooLong)}\n`);
    };
    const unreachable = (error: Error) =>
      answer({ id: request.id, error: `Can't reach OpenCode: ${error.message}` });
    const body = request.body === undefined ? undefined : JSON.stringify(request.body);
    const headers: OutgoingHttpHeaders = { authorization, accept: "application/json" };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(body);
    }
    try {
      const outgoing = httpRequest(
        {
          host: target.host,
          port: target.port,
          method: request.method,
          path: request.path,
          agent: false,
          headers,
        },
        (response) => {
          const chunks: Array<Buffer> = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size <= MAX_LINE_BYTES) return void chunks.push(chunk);
            answer(tooLong);
            response.destroy();
          });
          response.on("error", unreachable);
          // A response cut short emits `error`, not `end`.
          response.on("end", () =>
            answer({
              id: request.id,
              status: response.statusCode ?? 0,
              body: answerBody(Buffer.concat(chunks).toString("utf8")),
            }),
          );
        },
      );
      outgoing.on("error", unreachable);
      outgoing.end(body);
    } catch (error) {
      answer({
        id: request.id,
        error: `Invalid request: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };

  // Relays the request in `line`, or answers it with the reason it is invalid or `refused`.
  const handle = (line: string, refused?: string) => {
    const parsed = inputLine(line);
    if ("request" in parsed) {
      if (refused !== undefined)
        return writeLine({ id: parsed.request.id, error: `The request ${refused}` });
      if (server !== undefined) relay(server, parsed.request);
      return;
    }
    if ("id" in parsed) return writeLine({ id: parsed.id, error: `The request ${parsed.invalid}` });
    warn(`skipping an input line of ${Buffer.byteLength(line)} bytes that ${parsed.invalid}`);
  };
  const accept = (line: string) => {
    if (line.trim() === "") return;
    if (ready) return handle(line);
    const bytes = Buffer.byteLength(line);
    if (waitingBytes + bytes > MAX_HELD_BYTES)
      return handle(
        line,
        `would exceed the ${MAX_HELD_BYTES} bytes of requests that the bridge holds until OpenCode is ready`,
      );
    waitingBytes += bytes;
    waiting.push(line);
  };
  const refuseLong = (bytes: number, head: string) => {
    const invalid = `is longer than ${MAX_LINE_BYTES} bytes`;
    const id = leadingId(head);
    if (id === undefined) return warn(`skipping an input line of ${bytes} bytes that ${invalid}`);
    writeLine({ id, error: `The request ${invalid}` });
  };

  // The stream reports serve's exit or a lost connection; give serve's exit time to arrive first.
  const lost = (reason: string) => {
    if (!closing) setTimeout(() => fail(reason), GRACE_MS);
  };
  const subscribe = (target: Server) => {
    readyWait = setTimeout(
      () =>
        fail(
          `OpenCode sent no event within ${READY_WAIT_MS / 1000} seconds of reporting its address`,
        ),
      READY_WAIT_MS,
    );
    const events = httpRequest(
      {
        host: target.host,
        port: target.port,
        method: "GET",
        path: "/api/event",
        agent: false,
        headers: { authorization, accept: "text/event-stream" },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          return fail(`OpenCode refused the event subscription with status ${response.statusCode}`);
        }
        // OpenCode sends its first event once the subscription is registered.
        const arrived = () => {
          if (ready) return;
          ready = true;
          clearTimeout(readyWait);
          writeLine({ ready: true });
          for (const line of waiting.splice(0)) handle(line);
        };
        // Holds OpenCode's events while standard output is full, so a slow reader leaves no backlog
        // in the bridge.
        let paused = false;
        const forward = (line: string) => {
          if (process.stdout.write(line) || paused) return;
          paused = true;
          response.pause();
          process.stdout.once("drain", () => {
            paused = false;
            response.resume();
          });
        };
        const tooLong = (bytes: number) =>
          warn(
            `skipping an OpenCode event of ${bytes} bytes that is too long for a line of ${MAX_LINE_BYTES} bytes`,
          );
        response.setEncoding("utf8");
        response.on(
          "data",
          eventStream(
            (data) => {
              arrived();
              const event = parseJson(data);
              if (event === undefined || !isObject(event.value))
                return warn(
                  `skipping an OpenCode event of ${Buffer.byteLength(data)} bytes that isn't a JSON object`,
                );
              const line = outputLine({ event: event.value });
              if (line === undefined) return tooLong(Buffer.byteLength(data));
              forward(line);
            },
            (bytes) => {
              arrived();
              tooLong(bytes);
            },
          ),
        );
        response.on("error", (error) => lost(`OpenCode's event stream failed: ${error.message}`));
        response.on("close", () => lost("OpenCode closed the event stream"));
      },
    );
    events.on("error", (error) => lost(`Can't subscribe to OpenCode's events: ${error.message}`));
    events.end();
  };

  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});
  serve.stdin.on("error", () => {});
  serve.stderr.pipe(process.stderr);
  // Lines before the ready line, and all lines after it, are diagnostics.
  const output = lineReader(
    (line) => {
      if (server === undefined) {
        server = readyLine(line);
        if (server !== undefined) return subscribe(server);
      }
      process.stderr.write(`${line}\n`);
    },
    (bytes) =>
      warn(
        `skipping an OpenCode output line of ${bytes} bytes that is longer than ${MAX_LINE_BYTES} bytes`,
      ),
  );
  serve.stdout.setEncoding("utf8");
  serve.stdout.on("data", output.push);
  serve.stdout.on("end", output.end);
  serve.on("error", (error) => {
    warn(`can't run OpenCode: ${error.message}`);
    if (serve.pid === undefined) finish(127);
  });
  serve.on("exit", (code, signal) => {
    clearTimeout(readyWait);
    const exitCode = code ?? (signal === null ? 1 : 128 + (constants.signals[signal] ?? 0));
    const done = () => finish(failed && exitCode === 0 ? 1 : exitCode);
    serve.on("close", done);
    setTimeout(done, GRACE_MS);
  });

  const input = lineReader(accept, refuseLong);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", input.push);
  process.stdin.on("end", () => {
    input.end();
    closing = true;
    serve.stdin.end();
  });
};

main();

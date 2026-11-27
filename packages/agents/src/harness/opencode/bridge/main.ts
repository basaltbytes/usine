// This standalone Node entry point relays an OpenCode server and its client MCP sockets over JSON
// lines on its standard streams, without runtime dependencies, and reports its own failures
// through stderr.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalJson:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics processEnv:off
/* oxlint-disable usine/no-runtime-typeof -- This standalone program parses its JSON lines without Schema. */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { type OutgoingHttpHeaders, request as httpRequest } from "node:http";
import { constants } from "node:os";
import { MCP_RECONNECT_MS, nextReconnectDelay } from "./reconnect.ts";

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
/** A line that attaches the client's MCP server `name` to OpenCode in `directory`. */
interface McpConnect {
  readonly id: RequestId;
  readonly name: string;
  readonly directory: string;
}
/** A message that the client's MCP server `name` sends to OpenCode. */
interface McpSend {
  readonly name: string;
  readonly message: JsonObject;
}
type InputLine =
  | { readonly request: Request }
  | { readonly connect: McpConnect }
  | { readonly send: McpSend }
  | { readonly id: RequestId; readonly invalid: string }
  | { readonly invalid: string };
/** The socket of a client MCP server, which the bridge reopens until its input ends. */
interface McpSocket {
  readonly directory: string;
  socket: WebSocket | undefined;
  /** Whether the socket is open. */
  open: boolean;
  /** Whether a socket of this server has opened since the client attached it. */
  attached: boolean;
  /** The connect lines that wait for the socket to open. */
  readonly waiting: Array<RequestId>;
  /** Milliseconds before the next reconnection. */
  delay: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** The last socket error, which the close reports. */
  error: string | undefined;
}

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
 * The prefix of the variables that the bridge sets on `serve` only, without the prefix. Tool
 * commands get the bridge's environment without them, through each session's command environment.
 */
const SERVE_ONLY_PREFIX = "USINE_OPENCODE_SERVE_";
/**
 * Milliseconds to wait for `serve`'s remaining output after it exits, and for its exit after its
 * event stream closes.
 */
const GRACE_MS = 1000;
/**
 * The most bytes in a line, without its newline, that the bridge reads or writes. It equals
 * `MAX_PROTOCOL_LINE_BYTES` in `child-host/lines.ts`, the longest line that the client reads.
 */
const MAX_LINE_BYTES = 4 * 1024 ** 2;
/** The most bytes of input lines that the bridge holds until OpenCode is ready. */
const MAX_HELD_BYTES = MAX_LINE_BYTES;
/** The characters that the bridge keeps from the start of a line longer than `MAX_LINE_BYTES`. */
const HEAD_LENGTH = 256;
/**
 * The most characters in a string request ID. It keeps each answer that the bridge writes with the
 * ID shorter than `MAX_LINE_BYTES`, and equals the bound of `BridgeRequestId` in `lines.ts`.
 */
const MAX_ID_LENGTH = 128;
/** OpenCode's path for the MCP servers that a client hosts over a WebSocket. */
const CLIENT_MCP_PATH = "/api/experimental/client-mcp";
/** The name of a client MCP server, as OpenCode accepts it. */
const MCP_NAME = /^[A-Za-z0-9_-]+$/u;
/** Node's WebSocket client, whose constructor also takes the headers of the opening request. */
type NodeWebSocket = new (
  url: URL,
  init?: string | Array<string> | { readonly headers: Readonly<Record<string, string>> },
) => WebSocket;
// SAFETY: Node's global WebSocket is undici's, which reads `headers` from its second argument.
const NodeWebSocket = WebSocket as NodeWebSocket;

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

/** Returns `value` when it is a request ID: a string of at most `MAX_ID_LENGTH` characters or a safe integer. */
const requestId = (value: Json | undefined): RequestId | undefined =>
  (typeof value === "string" && value.length <= MAX_ID_LENGTH) ||
  (typeof value === "number" && Number.isSafeInteger(value))
    ? value
    : undefined;

/** The OpenCode session ID that an environment line names, such as `ses_dfda5480fffekNd7DilJmssCG2`. */
const SESSION_ID = /^ses_[A-Za-z0-9]+$/u;

/**
 * Parses an input line: a request; an environment line `{"id":...,"environment":"<session>"}`,
 * which becomes `PUT /api/session/<session>/environment` with `tools` as the session's variables;
 * an MCP connect line `{"id":...,"mcp":"<server>","directory":"<directory>"}`; or an MCP message
 * line `{"mcp":"<server>","message":{...}}`.
 */
const inputLine = (line: string, tools: JsonObject): InputLine => {
  const parsed = parseJson(line);
  if (parsed === undefined) return { invalid: "isn't JSON" };
  if (!isObject(parsed.value)) return { invalid: "isn't a JSON object" };
  const { method, path, body, environment, mcp, message, directory } = parsed.value;
  if (mcp !== undefined && message !== undefined) {
    if (typeof mcp !== "string" || !MCP_NAME.test(mcp)) return { invalid: "names no MCP server" };
    if (!isObject(message)) return { invalid: "has an MCP message that isn't a JSON object" };
    return { send: { name: mcp, message } };
  }
  const id = requestId(parsed.value.id);
  if (id === undefined) return { invalid: "has no request ID" };
  if (mcp !== undefined) {
    if (typeof mcp !== "string" || !MCP_NAME.test(mcp))
      return { id, invalid: "names no MCP server" };
    if (typeof directory !== "string" || !directory.startsWith("/"))
      return { id, invalid: "has no absolute MCP directory" };
    return { connect: { id, name: mcp, directory } };
  }
  if (environment !== undefined) {
    if (typeof environment !== "string" || !SESSION_ID.test(environment))
      return { id, invalid: "names no OpenCode session" };
    return {
      request: {
        id,
        method: "PUT",
        path: `/api/session/${environment}/environment`,
        body: { variables: tools },
      },
    };
  }
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
 * `oversized` with the size in bytes of each event's data that is longer than `MAX_LINE_BYTES` or
 * that has a line longer than `MAX_LINE_BYTES`.
 */
const eventStream = (dispatch: (data: string) => void, oversized: (bytes: number) => void) => {
  const data: Array<string> = [];
  let fields = 0;
  let bytes = 0;
  let tooLong = false;
  // Counts a data field of `size` bytes, and the newline that joins it to the previous one.
  const count = (size: number) => {
    bytes += (fields > 0 ? 1 : 0) + size;
    fields += 1;
    tooLong ||= bytes > MAX_LINE_BYTES;
    if (tooLong) data.length = 0;
  };
  const reader = lineReader(
    (line) => {
      if (line === "") {
        if (tooLong) oversized(bytes);
        else if (fields > 0) dispatch(data.join("\n"));
        data.length = 0;
        fields = 0;
        bytes = 0;
        tooLong = false;
        return;
      }
      const start = dataStart(line);
      if (start === undefined) return;
      const value = line.slice(start);
      count(Buffer.byteLength(value));
      if (!tooLong) data.push(value);
    },
    // A data line longer than `MAX_LINE_BYTES` has more than `MAX_LINE_BYTES - 6` bytes of data,
    // which make an event line longer than `MAX_LINE_BYTES`.
    (lineBytes, head) => {
      const start = dataStart(head);
      if (start === undefined) return;
      tooLong = true;
      count(lineBytes - start);
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

/**
 * Runs the bridge with its arguments: the milliseconds to wait for OpenCode's first event once
 * `serve` reports its address, then the OpenCode command with any leading arguments.
 */
const main = () => {
  const [wait, command, ...args] = process.argv.slice(1);
  const warn = (message: string) => {
    process.stderr.write(`opencode bridge: ${message}\n`);
  };
  const readyWaitMs = Number(wait);
  if (!Number.isSafeInteger(readyWaitMs) || readyWaitMs <= 0) {
    warn("missing the milliseconds to wait for OpenCode's first event");
    process.exitCode = 2;
    return;
  }
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
  const tools: Record<string, string> = {};
  const serveOnly: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    if (!name.startsWith(SERVE_ONLY_PREFIX)) tools[name] = value;
    else if (name.length > SERVE_ONLY_PREFIX.length)
      serveOnly[name.slice(SERVE_ONLY_PREFIX.length)] = value;
  }
  const serve = spawn(command, [...args, ...SERVE_ARGUMENTS], {
    env: { ...tools, ...serveOnly, OPENCODE_PASSWORD: password },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let server: Server | undefined;
  let ready = false;
  let closing = false;
  let failed = false;
  let finished = false;
  /** Whether serve exited, after which no client MCP socket reopens. */
  let exited = false;
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

  const sockets = new Map<string, McpSocket>();
  /** Opens the client MCP socket of server `name` on `target`, and reopens it when it closes. */
  const openSocket = (target: Server, name: string, entry: McpSocket) => {
    entry.timer = undefined;
    const host = target.host.includes(":") ? `[${target.host}]` : target.host;
    const url = new URL(`ws://${host}:${target.port}${CLIENT_MCP_PATH}`);
    url.searchParams.set("location[directory]", entry.directory);
    url.searchParams.set("name", name);
    const socket = new NodeWebSocket(url, { headers: { authorization } });
    entry.socket = socket;
    entry.error = undefined;
    socket.addEventListener("open", () => {
      if (closing) return socket.close(1000);
      entry.open = true;
      entry.attached = true;
      entry.delay = MCP_RECONNECT_MS;
      for (const id of entry.waiting.splice(0)) writeLine({ id, status: 101, body: null });
    });
    let ended = false;
    // Handles the socket's end once: Node's WebSocket reports a refused opening only as an error.
    const end = (code: number, reason: string) => {
      if (ended) return;
      ended = true;
      const wasOpen = entry.open;
      entry.open = false;
      if (entry.socket === socket) entry.socket = undefined;
      if (closing || exited) return;
      const why = [`code ${code}`, reason, entry.error]
        .filter((part) => part !== undefined && part !== "")
        .join(": ");
      if (!entry.attached) {
        sockets.delete(name);
        for (const id of entry.waiting.splice(0))
          writeLine({ id, error: `Can't open OpenCode's MCP socket for ${name} (${why})` });
        return;
      }
      if (wasOpen) writeLine({ mcp: name, closed: why });
      warn(`OpenCode closed the MCP socket of ${name} (${why}); reconnecting in ${entry.delay} ms`);
      entry.timer = setTimeout(() => openSocket(target, name, entry), entry.delay);
      entry.delay = nextReconnectDelay(entry.delay);
    };
    socket.addEventListener("error", (event) => {
      entry.error = "message" in event && typeof event.message === "string" ? event.message : "";
      end(1006, "");
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string")
        return warn(`skipping a binary message on the MCP socket of ${name}`);
      const parsed = parseJson(event.data);
      if (parsed === undefined || !isObject(parsed.value))
        return warn(
          `skipping a message of ${Buffer.byteLength(event.data)} bytes on the MCP socket of ${name} that isn't a JSON object`,
        );
      const line = outputLine({ mcp: name, message: parsed.value });
      if (line !== undefined) return void process.stdout.write(line);
      warn(
        `skipping a message of ${Buffer.byteLength(event.data)} bytes on the MCP socket of ${name} that is too long for a line of ${MAX_LINE_BYTES} bytes`,
      );
      // OpenCode waits for the answer to a request, so the bridge refuses it.
      const { id, method } = parsed.value;
      if (requestId(id) !== undefined && typeof method === "string")
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32603,
              message: `The usine bridge can't relay a ${method} request this long`,
            },
          }),
        );
    });
    socket.addEventListener("close", (event) => end(event.code, event.reason));
  };
  /** Attaches the client MCP server that `connect` names, or answers that it is attached. */
  const connectMcp = (target: Server, connect: McpConnect) => {
    const existing = sockets.get(connect.name);
    if (existing === undefined) {
      const entry: McpSocket = {
        directory: connect.directory,
        socket: undefined,
        open: false,
        attached: false,
        waiting: [connect.id],
        delay: MCP_RECONNECT_MS,
        timer: undefined,
        error: undefined,
      };
      sockets.set(connect.name, entry);
      return openSocket(target, connect.name, entry);
    }
    if (existing.directory !== connect.directory)
      return writeLine({
        id: connect.id,
        error: `The MCP server ${connect.name} is attached in another directory`,
      });
    if (existing.open) return writeLine({ id: connect.id, status: 200, body: null });
    existing.waiting.push(connect.id);
  };
  /** Sends `send.message` over the socket of its server, or drops it when the socket is closed. */
  const sendMcp = (send: McpSend) => {
    const entry = sockets.get(send.name);
    if (entry?.socket === undefined || !entry.open)
      return warn(`dropping a message for the MCP server ${send.name}, whose socket isn't open`);
    entry.socket.send(JSON.stringify(send.message));
  };
  const closeSockets = () => {
    for (const entry of sockets.values()) {
      clearTimeout(entry.timer);
      entry.socket?.close(1000);
    }
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
    const parsed = inputLine(line, tools);
    if ("send" in parsed) {
      if (refused !== undefined)
        return warn(`dropping a message for the MCP server ${parsed.send.name}: it ${refused}`);
      return sendMcp(parsed.send);
    }
    if ("connect" in parsed) {
      if (refused !== undefined)
        return writeLine({ id: parsed.connect.id, error: `The request ${refused}` });
      if (server !== undefined) connectMcp(server, parsed.connect);
      return;
    }
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
          `OpenCode sent no event within ${readyWaitMs / 1000} seconds of reporting its address`,
        ),
      readyWaitMs,
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
        const skipLong = (bytes: number) =>
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
              if (line === undefined) return skipLong(Buffer.byteLength(data));
              forward(line);
            },
            (bytes) => {
              arrived();
              skipLong(bytes);
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
    exited = true;
    closeSockets();
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
    closeSockets();
    serve.stdin.end();
  });
};

main();

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

const inputLine = (line: string): InputLine => {
  const parsed = parseJson(line);
  if (parsed === undefined) return { invalid: "isn't JSON" };
  if (!isObject(parsed.value)) return { invalid: "isn't a JSON object" };
  const { id, method, path, body } = parsed.value;
  if (typeof id !== "string" && !(typeof id === "number" && Number.isSafeInteger(id)))
    return { invalid: "has no request ID" };
  if (typeof method !== "string" || !/^[A-Z]+$/u.test(method))
    return { id, invalid: "has no HTTP method" };
  // Keeps the request target in origin form. The host and port come from serve's ready line.
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//"))
    return { id, invalid: "has no absolute path" };
  return { request: body === undefined ? { id, method, path } : { id, method, path, body } };
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

/** Returns a reader of event-stream text that calls `dispatch` with the data of each event. */
const eventStream = (dispatch: (data: string) => void) => {
  let buffer = "";
  const data: Array<string> = [];
  return (text: string) => {
    const lines = (buffer + text).split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines.map((line) => line.replace(/\r$/u, ""))) {
      if (line === "") {
        if (data.length > 0) dispatch(data.splice(0).join("\n"));
        continue;
      }
      const colon = line.indexOf(":");
      if (colon === 0 || (colon === -1 ? line : line.slice(0, colon)) !== "data") continue;
      data.push(colon === -1 ? "" : line.slice(colon + 1).replace(/^ /u, ""));
    }
  };
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
  const {
    OPENCODE_PASSWORD: _inheritedPassword,
    OPENCODE_SERVER_PASSWORD: _inheritedServerPassword,
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
    const answer = (line: JsonObject) => {
      if (answered) return;
      answered = true;
      writeLine(line);
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
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
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

  const handle = (line: string) => {
    if (line.trim() === "") return;
    const parsed = inputLine(line);
    if ("request" in parsed) {
      if (server !== undefined) relay(server, parsed.request);
      return;
    }
    if ("id" in parsed) return writeLine({ id: parsed.id, error: `The request ${parsed.invalid}` });
    warn(`skipping an input line of ${Buffer.byteLength(line)} bytes that ${parsed.invalid}`);
  };
  const accept = (line: string) => {
    if (ready) handle(line);
    else waiting.push(line);
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
        response.setEncoding("utf8");
        response.on(
          "data",
          eventStream((data) => {
            // OpenCode sends its first event once the subscription is registered.
            if (!ready) {
              ready = true;
              clearTimeout(readyWait);
              writeLine({ ready: true });
              for (const line of waiting.splice(0)) handle(line);
            }
            const event = parseJson(data);
            if (event === undefined || !isObject(event.value))
              return warn(
                `skipping an OpenCode event of ${Buffer.byteLength(data)} bytes that isn't a JSON object`,
              );
            writeLine({ event: event.value });
          }),
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
  let output = "";
  serve.stdout.setEncoding("utf8");
  // Lines before the ready line, and all output after it, are diagnostics.
  serve.stdout.on("data", (text: string) => {
    if (server !== undefined) return void process.stderr.write(text);
    const lines = (output + text).split("\n");
    output = lines.pop() ?? "";
    for (const [index, line] of lines.entries()) {
      server = readyLine(line);
      if (server !== undefined) {
        subscribe(server);
        process.stderr.write([...lines.slice(index + 1), output].join("\n"));
        output = "";
        return;
      }
      process.stderr.write(`${line}\n`);
    }
  });
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

  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (text: string) => {
    const lines = (input + text).split("\n");
    input = lines.pop() ?? "";
    for (const line of lines) accept(line);
  });
  process.stdin.on("end", () => {
    if (input !== "") accept(input);
    closing = true;
    serve.stdin.end();
  });
};

main();

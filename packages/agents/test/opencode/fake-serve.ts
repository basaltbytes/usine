// A scripted stand-in for `opencode serve --stdio`, bundled and run with `node -e` by the tests.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalJson:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics processEnv:off
import type { Schema } from "effect";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { OpenCodeEvent } from "../../src/harness/opencode/bridge/lines.ts";

type Route = (request: IncomingMessage, response: ServerResponse) => void;

/**
 * The scenario in `FAKE_SERVE_SCENARIO`:
 *
 * - `ready` starts at once.
 * - `slow` reports its URL and then registers event subscriptions after a delay.
 * - `long-line` writes a line longer than the bridge's 4 MiB line limit before its ready line.
 * - `foreign-url` reports a URL on a host that isn't a loopback address before its own.
 * - `exit-before-ready` fails before its ready line.
 * - `no-events` accepts the event subscription and sends no event.
 * - `refuse-events` answers the event subscription with 401.
 * - `refuse-events-at-end` holds the event subscription and answers it with 401 at end of input.
 * - `helper` starts a detached process that keeps its stdout and stderr open after it exits.
 */
const scenario = process.env.FAKE_SERVE_SCENARIO ?? "ready";
/** The exit code at end of input, from `FAKE_SERVE_EXIT_CODE`. */
const exitCode = Number(process.env.FAKE_SERVE_EXIT_CODE ?? "7");
const password = process.env.OPENCODE_PASSWORD;
// Like `serve --stdio`, which keeps the password from the commands it runs.
delete process.env.OPENCODE_PASSWORD;
const SLOW_MS = 300;
/**
 * The number of 1 MiB events that `POST /api/flood` sends: more than the TCP buffers between serve
 * and the bridge hold.
 */
const FLOOD_EVENTS = 32;
/** Text one byte longer than the bridge's 4 MiB line limit. */
const LARGE_TEXT = "x".repeat(4 * 1024 ** 2 + 1);

const subscribers = new Set<ServerResponse>();
const held = new Set<ServerResponse>();
/** Writes `event` to every subscriber and calls `then` once the frames are on the wire. */
const emit = (event: OpenCodeEvent, then?: () => void) => {
  let pending = subscribers.size;
  for (const subscriber of subscribers)
    subscriber.write(`data: ${JSON.stringify(event)}\n\n`, () => {
      pending -= 1;
      if (pending === 0) then?.();
    });
};
const json = (response: ServerResponse, status: number, body: Schema.Json) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};
const readBody = (request: IncomingMessage, then: (body: string) => void) => {
  let text = "";
  request.setEncoding("utf8");
  request.on("data", (chunk: string) => (text += chunk));
  request.on("end", () => then(text));
};

const routes = new Map<string, Route>(
  Object.entries({
    "GET /api/event": (_request, response) => {
      if (scenario === "refuse-events") return json(response, 401, { _tag: "UnauthorizedError" });
      if (scenario === "no-events") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        return void response.write(": heartbeat\n\n");
      }
      if (scenario === "refuse-events-at-end") {
        held.add(response);
        return void process.stderr.write("fake serve: holding the event subscription\n");
      }
      const subscribe = () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        subscribers.add(response);
        response.on("close", () => subscribers.delete(response));
        response.write(`data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n`);
        response.write(": heartbeat\n\n");
      };
      if (scenario === "slow") setTimeout(subscribe, SLOW_MS);
      else subscribe();
    },
    "GET /api/start": (_request, response) =>
      json(response, 200, {
        args: process.argv.slice(1),
        passwordInArguments:
          password !== undefined && process.argv.some((arg) => arg.includes(password)),
        passwordInEnvironment:
          process.env.OPENCODE_PASSWORD !== undefined ||
          process.env.OPENCODE_SERVER_PASSWORD !== undefined,
      }),
    "POST /api/echo": (request, response) => {
      readBody(request, (body) =>
        json(response, 201, {
          method: request.method ?? "",
          path: request.url ?? "",
          contentType: request.headers["content-type"] ?? null,
          body: body === "" ? null : JSON.parse(body),
        }),
      );
    },
    "GET /api/empty": (_request, response) => {
      response.writeHead(204);
      response.end();
    },
    "GET /api/large": (_request, response) => json(response, 200, { text: LARGE_TEXT }),
    "POST /api/large-event": (_request, response) => {
      emit({ type: "large", data: { text: LARGE_TEXT } });
      emit({ type: "after.large", data: {} });
      json(response, 200, {});
    },
    // Sends FLOOD_EVENTS events of 1 MiB to the first subscriber, waiting for `drain` when a write
    // fills its buffer. Reports on stderr each wait that lasts a second, and the end.
    "POST /api/flood": (_request, response) => {
      json(response, 200, {});
      const [subscriber] = subscribers;
      if (subscriber === undefined) return;
      const frame = `data: ${JSON.stringify({ type: "flood", data: { text: "x".repeat(1024 ** 2) } })}\n\n`;
      let sent = 0;
      const send = () => {
        while (sent < FLOOD_EVENTS) {
          sent += 1;
          if (subscriber.write(frame)) continue;
          const stalled = setTimeout(
            () => process.stderr.write(`fake serve: flood stalled after ${sent} events\n`),
            1000,
          );
          return void subscriber.once("drain", () => {
            clearTimeout(stalled);
            send();
          });
        }
        process.stderr.write("fake serve: flood sent\n");
      };
      send();
    },
    "GET /api/text": (_request, response) => {
      response.writeHead(502, { "content-type": "text/plain" });
      response.end("bad gateway");
    },
    // Ends every event stream and keeps running.
    "POST /api/end-events": (_request, response) => {
      for (const subscriber of subscribers) subscriber.end();
      json(response, 200, {});
    },
    // Like a server that shuts down cleanly: ends every event stream, then exits 100 ms later with
    // the exit code from `FAKE_SERVE_EXIT_CODE`.
    "POST /api/shutdown": (_request, response) => {
      for (const subscriber of subscribers) subscriber.end();
      json(response, 200, {});
      setTimeout(() => process.exit(exitCode), 100);
    },
    // Promises 10 bytes, sends one, and closes the connection.
    "GET /api/cut": (_request, response) => {
      response.writeHead(200, { "content-type": "application/json", "content-length": "10" });
      response.write("{", () => response.socket?.destroy());
    },
    "POST /api/crash": () => {
      process.stderr.write("fake serve: crashed while answering\n");
      process.exit(4);
    },
    // Sends the event and the answer, in the order that the query names, 50 ms apart and 300 ms after
    // reporting the request on stderr, so that a test can stop the bridge before both arrive.
    "POST /api/order": (request, response) => {
      const first = request.url?.endsWith("?first=answer") === true ? "answer" : "event";
      process.stderr.write(`fake serve: order ${first} received\n`);
      const body = JSON.stringify({ answered: true });
      const answer = (then?: () => void) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(body, then);
      };
      const event = (then?: () => void) => emit({ type: "order", data: {} }, then);
      const [one, two] = first === "answer" ? [answer, event] : [event, answer];
      setTimeout(() => one(() => setTimeout(() => two(), 50)), 300);
    },
    "POST /api/garbage": (_request, response) => {
      for (const subscriber of subscribers) {
        subscriber.write("data: {not json\n\n");
        subscriber.write("data: [1, 2]\n\n");
      }
      emit({ type: "after.garbage", data: {} });
      json(response, 200, {});
    },
  } satisfies Record<string, Route>),
);

if (scenario === "exit-before-ready") {
  process.stderr.write("fake serve: the configuration is invalid\n");
  process.exit(3);
}
process.stderr.write(`fake serve: started with ${process.argv.slice(1).join(" ")}\n`);
const server = createServer((request, response) => {
  if (request.headers.authorization !== `Basic ${btoa(`opencode:${password}`)}`)
    return json(response, 401, { _tag: "UnauthorizedError" });
  const route = routes.get(`${request.method} ${request.url?.split("?")[0]}`);
  if (route === undefined) {
    response.writeHead(404);
    return response.end();
  }
  route(request, response);
});
server.listen(0, "127.0.0.1", () => {
  // SAFETY: a server listening on a TCP port reports an AddressInfo, never a pipe name or null.
  const { port } = server.address() as AddressInfo;
  const ready = () => {
    process.stdout.write("a line before the ready line\n");
    if (scenario === "long-line") process.stdout.write(`${LARGE_TEXT}\n`);
    if (scenario === "foreign-url")
      process.stdout.write(`${JSON.stringify({ url: `http://192.0.2.1:${port}` })}\n`);
    process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${port}` })}\n`);
  };
  if (scenario === "slow") setTimeout(ready, SLOW_MS);
  else ready();
});
if (scenario === "helper") {
  // Like OpenCode's terminal daemon, the helper keeps serve's output open after serve exits.
  const helper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
  });
  helper.unref();
  process.stderr.write(`fake serve: helper ${helper.pid}\n`);
}
// Like `serve --stdio`, end of input ends the lease. The default exit code, 7, shows that it arrived.
process.stdin.on("end", () => {
  process.stderr.write("fake serve: end of input\n");
  if (held.size === 0) process.exit(exitCode);
  for (const response of held) json(response, 401, { _tag: "UnauthorizedError" });
  // Gives the bridge time to read the refusal before serve's exit.
  setTimeout(() => process.exit(exitCode), 300);
});
process.stdin.resume();

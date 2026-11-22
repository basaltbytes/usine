// A scripted stand-in for `opencode serve --stdio`, bundled and run with `node -e` by the tests.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalJson:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics processEnv:off
import type { Schema } from "effect";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { OpenCodeEvent } from "../../src/harness/opencode/bridge/lines.ts";

type Route = (request: IncomingMessage, response: ServerResponse) => void;

/**
 * The scenario in `FAKE_SERVE_SCENARIO`: `ready` starts at once, `slow` reports its URL and then
 * registers event subscriptions after a delay, and `exit-before-ready` fails before its ready line.
 */
const scenario = process.env.FAKE_SERVE_SCENARIO ?? "ready";
const password = process.env.OPENCODE_PASSWORD;
// Like `serve --stdio`, which keeps the password from the commands it runs.
delete process.env.OPENCODE_PASSWORD;
const SLOW_MS = 300;

const subscribers = new Set<ServerResponse>();
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
    "GET /api/text": (_request, response) => {
      response.writeHead(502, { "content-type": "text/plain" });
      response.end("bad gateway");
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
    process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${port}` })}\n`);
  };
  if (scenario === "slow") setTimeout(ready, SLOW_MS);
  else ready();
});
// Like `serve --stdio`, end of input ends the lease; exit 7 shows that it arrived.
process.stdin.on("end", () => {
  process.stderr.write("fake serve: end of input\n");
  process.exit(7);
});
process.stdin.resume();

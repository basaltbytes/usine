// A scripted stand-in for `opencode serve --stdio`, bundled and run with `node -e` by the tests.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalJson:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics processEnv:off
import type { Schema } from "effect";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
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
 * - `refuse-mcp` refuses every client MCP socket with 403.
 *
 * Like OpenCode, the fake sends `initialize` on each client MCP socket that opens, with the
 * server's name, directory, and the number of sockets opened so far. It reports each message that
 * a socket receives as a `fake.mcp` event.
 */
const scenario = process.env.FAKE_SERVE_SCENARIO ?? "ready";
/** The exit code at end of input, from `FAKE_SERVE_EXIT_CODE`. */
const exitCode = Number(process.env.FAKE_SERVE_EXIT_CODE ?? "7");
const password = process.env.OPENCODE_PASSWORD;
// Like OpenCode's server, whose documentation lets this variable replace the user name.
const userName = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
// Like `serve --stdio`, which keeps the password from the commands it runs.
delete process.env.OPENCODE_PASSWORD;
const SLOW_MS = 300;
/**
 * The number of 1 MiB events that `POST /api/flood` sends: more than the TCP buffers between serve
 * and the bridge hold.
 */
const FLOOD_EVENTS = 32;
/** The bridge's line limit, 4 MiB. */
const LINE_LIMIT = 4 * 1024 ** 2;
/** Text one byte longer than the bridge's line limit. */
const LARGE_TEXT = "x".repeat(LINE_LIMIT + 1);
/** The bytes of `GET /api/large`'s body: far more than the bridge reads of a response. */
const LARGE_RESPONSE_BYTES = 64 * 1024 ** 2;

/** The open client MCP sockets, by server name. */
const mcpSockets = new Map<string, Duplex>();
let mcpConnections = 0;
/** Returns a WebSocket frame of the server, which is never masked. */
const frame = (opcode: number, payload: Buffer) => {
  const { length } = payload;
  const header =
    length < 126
      ? Buffer.from([0x80 | opcode, length])
      : length < 0x10000
        ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
        : Buffer.concat([Buffer.from([0x80 | opcode, 127]), bigEndian64(length)]);
  return Buffer.concat([header, payload]);
};
const bigEndian64 = (value: number) => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
};
const sendText = (socket: Duplex, text: string) => socket.write(frame(1, Buffer.from(text)));
/** Returns a reader of the client's frames, which are masked and unfragmented. */
const frames = (onText: (text: string) => void, onClose: () => void) => {
  let buffer = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = (buffer[0] ?? 0) & 0x0f;
      let length = (buffer[1] ?? 0) & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (buffer.length < offset + 4 + length) return;
      const mask = buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
      for (let index = 0; index < payload.length; index++)
        payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
      buffer = buffer.subarray(offset + 4 + length);
      if (opcode === 1) onText(payload.toString("utf8"));
      if (opcode === 8) onClose();
    }
  };
};
/** Closes every client MCP socket with code 1011, as a server that restarts its MCP host does. */
const closeMcpSockets = () => {
  const reason = Buffer.from("fake restart");
  const code = Buffer.alloc(2);
  code.writeUInt16BE(1011);
  for (const socket of mcpSockets.values()) socket.end(frame(8, Buffer.concat([code, reason])));
  mcpSockets.clear();
};

const subscribers = new Set<ServerResponse>();
const held = new Set<ServerResponse>();
/** Writes `event` to every subscriber. */
const emit = (event: OpenCodeEvent) => {
  for (const subscriber of subscribers) subscriber.write(`data: ${JSON.stringify(event)}\n\n`);
};
const json = (response: ServerResponse, status: number, body: Schema.Json) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};
/** Returns the JSON of `{"type": type, "data": {"text": ...}}` with `bytes` bytes. */
const padded = (type: string, bytes: number) => {
  const empty = JSON.stringify({ type, data: { text: "" } });
  return JSON.stringify({ type, data: { text: "x".repeat(bytes - empty.length) } });
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
    // The variables that the tests set to tell serve's environment from the bridge's.
    "GET /api/environment": (_request, response) =>
      json(response, 200, {
        shared: process.env.FAKE_SHARED ?? null,
        serveOnly: process.env.FAKE_SERVE_ONLY ?? null,
        prefixed: Object.keys(process.env).some((name) => name.startsWith("USINE_OPENCODE_SERVE_")),
      }),
    "PUT /api/session/ses_fake/environment": (request, response) => {
      readBody(request, (body) => json(response, 200, JSON.parse(body)));
    },
    "GET /api/empty": (_request, response) => {
      response.writeHead(204);
      response.end();
    },
    // Sends LARGE_RESPONSE_BYTES in 1 MiB chunks, waiting for `drain` when a write fills the
    // connection's buffer. Reports on stderr a connection that closes before the end.
    "GET /api/large": (_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      const chunk = "x".repeat(1024 ** 2);
      let sent = 0;
      response.on("close", () => {
        if (sent < LARGE_RESPONSE_BYTES)
          process.stderr.write(`fake serve: the large response closed after ${sent} bytes\n`);
      });
      const send = () => {
        while (sent < LARGE_RESPONSE_BYTES) {
          sent += chunk.length;
          if (!response.write(chunk)) return void response.once("drain", send);
        }
        response.end();
      };
      send();
    },
    // A JSON body that fits in a line, inside an answer line that doesn't.
    "GET /api/limit": (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(padded("limit", LINE_LIMIT - 5));
    },
    // Sends event data longer than a line that isn't JSON; JSON data that fits in a line, in a data
    // line that doesn't; JSON data in a data line that fits, in an event line that doesn't; two data
    // lines of 3 MiB that each fit in a line, and join to data that doesn't; and a small event.
    "POST /api/large-event": (_request, response) => {
      const third = "x".repeat(3 * 1024 ** 2);
      for (const subscriber of subscribers)
        for (const data of [
          LARGE_TEXT,
          padded("limit", LINE_LIMIT - 5),
          padded("limit", LINE_LIMIT - 6),
          `${third}\ndata: ${third}`,
        ])
          subscriber.write(`data: ${data}\n\n`);
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
    "POST /api/mcp-close": (_request, response) => {
      closeMcpSockets();
      json(response, 200, {});
    },
    // Sends a request longer than the bridge's line limit on every client MCP socket.
    "POST /api/mcp-large": (_request, response) => {
      for (const socket of mcpSockets.values())
        sendText(
          socket,
          JSON.stringify({
            jsonrpc: "2.0",
            id: 7,
            method: "tools/call",
            params: { text: LARGE_TEXT },
          }),
        );
      json(response, 200, {});
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
  if (request.headers.authorization !== `Basic ${btoa(`${userName}:${password}`)}`)
    return json(response, 401, { _tag: "UnauthorizedError" });
  const route = routes.get(`${request.method} ${request.url?.split("?")[0]}`);
  if (route === undefined) {
    response.writeHead(404);
    return response.end();
  }
  route(request, response);
});
server.on("upgrade", (request: IncomingMessage, socket: Duplex) => {
  const url = new URL(request.url ?? "/", "http://fake");
  const key = request.headers["sec-websocket-key"];
  const name = url.searchParams.get("name") ?? "";
  if (
    url.pathname !== "/api/experimental/client-mcp" ||
    request.headers.authorization !== `Basic ${btoa(`${userName}:${password}`)}` ||
    key === undefined ||
    scenario === "refuse-mcp"
  )
    return void socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`,
  );
  mcpConnections += 1;
  mcpSockets.set(name, socket);
  socket.on("error", () => {});
  socket.on(
    "data",
    frames(
      (text) => emit({ type: "fake.mcp", data: { name, message: JSON.parse(text) } }),
      () => {
        mcpSockets.delete(name);
        socket.end();
      },
    ),
  );
  sendText(
    socket,
    JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        name,
        directory: url.searchParams.get("location[directory]"),
        connection: mcpConnections,
      },
    }),
  );
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

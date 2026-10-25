import {
  ACCESS_CLIENT_ID_HEADER,
  ACCESS_CLIENT_SECRET_HEADER,
  CreateSandbox,
  ProcessId,
  SandboxCredentials,
} from "@usine/cloudflare";
import {
  decodeClientMessage,
  encodeServerMessage,
  Exited,
  outputFrame,
  Started,
} from "@usine/cloudflare/stream";
import { Effect, Option, Redacted, Schema } from "effect";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type WebSocket as ServerSocket, WebSocketServer } from "ws";

export const ACCESS_CLIENT_ID = "0123abcd.access";
export const ACCESS_CLIENT_SECRET = "service-token-secret";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

/** One sandbox of the fake Worker. */
export interface FakeSandbox {
  readonly name: string;
  readonly owner: string;
  readonly attempt: string;
  running: boolean;
  /** Whether usine holds the sandbox past its lease. */
  held: boolean;
  /** Whether the platform is stopping the container, as its drain marker reports. */
  draining: boolean;
  /** The GitHub token of each credential publication, in order; `null` for a revocation. */
  readonly github: Array<string | null>;
  /** The number of provider keys of each credential publication, in order. */
  readonly providers: Array<number>;
  /** The paths that exist in the sandbox's container. */
  readonly paths: Set<string>;
  /** The command lines it ran through its exec stream, in order. */
  readonly commands: Array<string>;
  /** The number of `stop` requests it received. */
  stops: number;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr?: string;
  readonly exitCode: number;
}

export interface FakeWorkerState {
  readonly sandboxes: Map<string, FakeSandbox>;
  /** Each request as `<method> <path>`, in order. */
  readonly requests: Array<string>;
  images: Array<string>;
  /** Command lines whose stream drops once, after `Started` and the first half of the output. */
  readonly dropOnce: Set<string>;
  /** Overrides the response to a command; return `None` for the default. */
  respond: (
    sandbox: FakeSandbox,
    words: ReadonlyArray<string>,
    stdin: string,
  ) => Option.Option<CommandResult>;
}

/** Returns the unquoted words of a remote command line, as `remoteShellCommand` quotes them. */
const commandWords = (line: string): Array<string> => {
  const exec = line.lastIndexOf("exec '");
  const tail = exec < 0 ? line : line.slice(exec + "exec ".length);
  return [...tail.matchAll(/'((?:[^']|'"'"')*)'/gu)].map(([, word]) =>
    (word ?? "").replaceAll(`'"'"'`, "'"),
  );
};

const ok = (stdout = ""): CommandResult => ({ stdout, exitCode: 0 });

/** Responds like a Linux container with git, claude, and codex, tracking created paths. */
const defaultResponse = (
  sandbox: FakeSandbox,
  words: ReadonlyArray<string>,
  stdin: string,
): CommandResult => {
  const [command = "", ...args] = words;
  const last = args.at(-1) ?? "";
  switch (command) {
    case "mkdir":
      for (const path of args.filter((arg) => !arg.startsWith("-"))) sandbox.paths.add(path);
      return ok();
    case "rm":
      for (const path of sandbox.paths)
        if (path === last || path.startsWith(`${last}/`)) sandbox.paths.delete(path);
      return ok();
    case "test":
      return { stdout: "", exitCode: sandbox.paths.has(last) ? 0 : 1 };
    case "mv":
      sandbox.paths.delete(args[0] ?? "");
      sandbox.paths.add(last);
      return ok();
    case "cat":
      return ok(stdin);
    case "claude":
      return ok("2.1.308 (Claude Code)\n");
    case "codex":
      return ok("codex-cli 0.159.2\n");
    case "sh":
      if (args[1]?.includes("ls -A"))
        return {
          stdout: "",
          exitCode: [...sandbox.paths].some((path) => path.startsWith(`${last}/`)) ? 0 : 1,
        };
      return ok();
    case "git": {
      if (args.includes("clone")) sandbox.paths.add(last);
      const worktree = args.indexOf("worktree");
      if (worktree >= 0 && args[worktree + 1] === "add")
        sandbox.paths.add(args[worktree + 3] ?? "");
      if (worktree >= 0 && args[worktree + 1] === "remove") sandbox.paths.delete(last);
      if (args.includes("--absolute-git-dir"))
        return ok("/home/usine/workspace/repos/acme_demo.git/worktrees/x\n");
      if (args.includes("rev-parse")) return ok(`${COMMIT}\n`);
      return ok();
    }
    default:
      return ok();
  }
};

const decodeCreate = Schema.decodeUnknownSync(Schema.toCodecJson(CreateSandbox));
const decodeCredentials = Schema.decodeUnknownSync(Schema.toCodecJson(SandboxCredentials));

const summaryOf = (sandbox: FakeSandbox) => ({
  name: sandbox.name,
  owner: sandbox.owner,
  attempt: sandbox.attempt,
  image: "usine",
  instanceType: "standard-4",
  createdAt: "2026-10-25T00:00:00.000Z",
  running: sandbox.running,
  held: sandbox.held,
  draining: sandbox.draining,
});

const readBody = (request: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => resolve(body));
  });

const json = (response: ServerResponse, status: number, body: Schema.Json) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

/** Runs one exec stream: the first message starts a command, then stdin until `StdinEnd`. */
const serveExec = (state: FakeWorkerState, sandbox: FakeSandbox, socket: ServerSocket) => {
  let line = "";
  let stdin = "";
  const finish = () => {
    const words = commandWords(line);
    const result = Option.getOrElse(state.respond(sandbox, words, stdin), () =>
      defaultResponse(sandbox, words, stdin),
    );
    const process = ProcessId.make("0123456789abcdef0123456789abcdef");
    socket.send(encodeServerMessage(new Started({ process })));
    if (state.dropOnce.delete(line)) {
      const half = result.stdout.slice(0, Math.floor(result.stdout.length / 2));
      socket.send(outputFrame("stdout", new TextEncoder().encode(half)));
      pendingAttach.set(process, { result, sent: half.length });
      socket.terminate();
      return;
    }
    socket.send(outputFrame("stdout", new TextEncoder().encode(result.stdout)));
    socket.send(outputFrame("stderr", new TextEncoder().encode(result.stderr ?? "")));
    socket.send(encodeServerMessage(new Exited({ exitCode: result.exitCode })));
    socket.close(1000);
  };
  socket.on("message", (data: Buffer, binary: boolean) => {
    if (binary) {
      stdin += data.toString();
      return;
    }
    Option.map(decodeClientMessage(data.toString()), (message) => {
      if (message._tag === "ExecStart") {
        line = message.command;
        sandbox.commands.push(line);
        if (!commandWords(line).includes("cat")) finish();
      } else finish();
    });
  });
};

const pendingAttach = new Map<string, { readonly result: CommandResult; readonly sent: number }>();

/**
 * Starts a fake sandbox Worker on a local port: the JSON API and the exec and attach streams,
 * behind the Access service token headers. Closes it when the scope closes.
 */
export const fakeWorker = Effect.gen(function* () {
  const state: FakeWorkerState = {
    sandboxes: new Map(),
    requests: [],
    images: ["usine"],
    dropOnce: new Set(),
    respond: () => Option.none(),
  };
  const sockets = new WebSocketServer({ noServer: true });
  const authorized = (request: IncomingMessage) =>
    request.headers[ACCESS_CLIENT_ID_HEADER] === ACCESS_CLIENT_ID &&
    request.headers[ACCESS_CLIENT_SECRET_HEADER] === ACCESS_CLIENT_SECRET;
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://worker.test");
      state.requests.push(`${request.method} ${url.pathname}`);
      if (!authorized(request)) return json(response, 401, {});
      if (url.pathname === "/v1/health")
        return json(response, 200, { protocol: 1, images: state.images });
      if (url.pathname === "/v1/sandboxes") {
        const owner = url.searchParams.get("owner");
        return json(response, 200, {
          sandboxes: [...state.sandboxes.values()]
            .filter((sandbox) => sandbox.owner === owner)
            .map(summaryOf),
        });
      }
      const [, , , name = "", action] = url.pathname.split("/");
      const sandbox = state.sandboxes.get(name);
      const body = await readBody(request);
      if (request.method === "PUT" && action === undefined) {
        const created = decodeCreate(JSON.parse(body));
        const existing =
          sandbox ??
          ({
            name,
            owner: created.owner,
            attempt: created.attempt,
            running: true,
            held: false,
            draining: false,
            github: [],
            providers: [],
            paths: new Set(),
            commands: [],
            stops: 0,
          } satisfies FakeSandbox);
        existing.running = true;
        existing.github.push(
          Option.getOrNull(Option.map(created.credentials.github, Redacted.value)),
        );
        existing.providers.push(created.credentials.providers.length);
        state.sandboxes.set(name, existing);
        return json(response, 200, summaryOf(existing));
      }
      if (sandbox === undefined) return json(response, 404, { _tag: "SandboxNotFound", name });
      if (request.method === "GET" && action === undefined)
        return json(response, 200, summaryOf(sandbox));
      if (request.method === "PUT" && action === "credentials") {
        if (!sandbox.running)
          return json(response, 503, { _tag: "ContainerUnavailable", name, message: "stopped" });
        const credentials = decodeCredentials(JSON.parse(body));
        sandbox.github.push(Option.getOrNull(Option.map(credentials.github, Redacted.value)));
        sandbox.providers.push(credentials.providers.length);
        return json(response, 200, summaryOf(sandbox));
      }
      if (request.method === "POST" && action === "hold") {
        if (!sandbox.running)
          return json(response, 503, { _tag: "ContainerUnavailable", name, message: "stopped" });
        sandbox.held = true;
        return json(response, 200, summaryOf(sandbox));
      }
      if (request.method === "POST" && action === "stop") {
        sandbox.stops += 1;
        return json(response, 200, { stopped: 0 });
      }
      if (request.method === "DELETE") {
        state.sandboxes.delete(name);
        return json(response, 200, { destroyed: true });
      }
      return json(response, 404, {});
    })();
  });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://worker.test");
    state.requests.push(`WS ${url.pathname}`);
    if (!authorized(request)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    const [, , , name = "", action, process = ""] = url.pathname.split("/");
    const sandbox = state.sandboxes.get(name);
    sockets.handleUpgrade(request, socket, head, (client) => {
      if (sandbox === undefined) return client.close(1011);
      if (action === "exec") return serveExec(state, sandbox, client);
      const pending = pendingAttach.get(process);
      if (pending === undefined) return client.close(1011);
      const offset = Number(url.searchParams.get("stdout"));
      client.send(
        outputFrame("stdout", new TextEncoder().encode(pending.result.stdout.slice(offset))),
      );
      client.send(encodeServerMessage(new Exited({ exitCode: pending.result.exitCode })));
      client.close(1000);
    });
  });
  yield* Effect.acquireRelease(
    Effect.callback<void>((resume) => {
      server.listen(0, "127.0.0.1", () => resume(Effect.void));
    }),
    () =>
      Effect.callback<void>((resume) => {
        for (const client of sockets.clients) client.terminate();
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  );
  // SAFETY: a server listening on a TCP port reports an AddressInfo, never a pipe name or null.
  const { port } = server.address() as AddressInfo;
  return { state, url: new URL(`http://127.0.0.1:${String(port)}`) };
});

/**
 * The `SshCommand` contract of `@usine/agents/child-host`, run against a fake OpenSSH client and
 * each stand-in for `ssh` with a fake of its transport. Every fake runs the command line with this
 * machine's `sh -c`, so each subject runs the same commands.
 */
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import type { SshCommand } from "@usine/agents/child-host";
import {
  ACCESS_CLIENT_ID_HEADER,
  ACCESS_CLIENT_SECRET_HEADER,
  decodeClientMessage,
  Exited,
  execPath,
  outputFrame,
  ProcessId,
  SandboxName,
  ServerMessage,
  Started,
} from "@usine/cloudflare/stream";
import { MachineId } from "@usine/core/worker";
import {
  type Cause,
  Config,
  Effect,
  FileSystem,
  Option,
  Predicate,
  Queue,
  Schema,
  type Scope,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { SHELL_ENVIRONMENT } from "../../src/cloudflare/shell/environment.ts";
import { parseStandInArguments, TRANSPORT_FAILURE } from "../../src/remote/stand-in.ts";
import { BOXD_SHELL_ENVIRONMENT } from "../../src/ssh/provisioner/boxd/shell/environment.ts";
import { fakeBoxdExec } from "../ssh/provisioner/fake-boxd-exec.ts";
import { runLocally } from "./local-command.ts";

/** A program under the contract, with a fake of its transport. */
interface Subject {
  readonly ssh: SshCommand;
  readonly environment: Readonly<Record<string, string>>;
  /** A destination whose commands run on this machine. */
  readonly reachable: string;
  /** A destination that the program can't reach. */
  readonly unreachable: string;
}

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** An OpenSSH-shaped client that runs the command line here, and fails to reach `unreachable.invalid`. */
const fakeOpenSsh = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped();
  const ssh = `${directory}/ssh`;
  yield* fs.writeFileString(
    ssh,
    `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o|-p|-i|-F|-J) shift 2 ;;
    --) shift; break ;;
    *) destination=$1; shift ;;
  esac
done
if [ "$destination" = unreachable.invalid ]; then
  echo "ssh: Could not resolve hostname $destination" >&2
  exit 255
fi
exec sh -c "$1"
`,
    { mode: 0o700 },
  );
  return {
    ssh: { command: ssh, args: ["-o", "BatchMode=yes"] },
    environment: {},
    reachable: "usine@203.0.113.7",
    unreachable: "unreachable.invalid",
  } satisfies Subject;
});

// @effect-diagnostics-next-line schemaSync:off
const encodeServerMessage = Schema.encodeSync(Schema.fromJsonString(ServerMessage));
const ACCESS_CLIENT_ID = "contract.access";
const ACCESS_CLIENT_SECRET = "contract-secret";
const SANDBOX = SandboxName.make("github-app-1.cf-one.contract");

/** The Cloudflare sandbox shell, with a Worker whose one sandbox runs commands here. */
const cloudflareShell = Effect.gen(function* () {
  const sockets = new WebSocketServer({ noServer: true });
  const context = yield* Effect.context<never>();
  const run = Effect.runForkWith(context);
  const server = createServer((_request, response) => response.writeHead(404).end());
  server.on("upgrade", (request, socket, head) => {
    const authorized =
      request.headers[ACCESS_CLIENT_ID_HEADER] === ACCESS_CLIENT_ID &&
      request.headers[ACCESS_CLIENT_SECRET_HEADER] === ACCESS_CLIENT_SECRET;
    if (!authorized) return socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    sockets.handleUpgrade(request, socket, head, (client) => {
      if (request.url !== execPath(SANDBOX)) return client.close(1011);
      const stdin = Effect.runSyncWith(context)(Queue.unbounded<Uint8Array, Cause.Done>());
      client.on("message", (data: Buffer, binary: boolean) => {
        if (binary) return Queue.offerUnsafe(stdin, new Uint8Array(data));
        Option.map(decodeClientMessage(data.toString()), (message) => {
          if (message._tag === "StdinEnd") return Queue.endUnsafe(stdin);
          client.send(
            encodeServerMessage(
              Started.make({ process: ProcessId.make("0123456789abcdef0123456789abcdef") }),
            ),
          );
          run(
            runLocally(message.command, Stream.fromQueue(stdin)).pipe(
              Stream.runForEach((event) =>
                Effect.sync(() =>
                  event._tag === "Output"
                    ? client.send(outputFrame(event.channel, event.bytes))
                    : client.send(encodeServerMessage(Exited.make({ exitCode: event.exitCode }))),
                ),
              ),
              Effect.andThen(Effect.sync(() => client.close(1000))),
            ),
          );
        });
      });
    });
  });
  const url = yield* listen(server);
  return {
    ssh: {
      command: process.execPath,
      args: ["--no-warnings", source("../../src/cloudflare/shell/shell.ts")],
    },
    environment: {
      [SHELL_ENVIRONMENT.workerUrl]: url,
      [SHELL_ENVIRONMENT.accessClientId]: ACCESS_CLIENT_ID,
      [SHELL_ENVIRONMENT.accessClientSecret]: ACCESS_CLIENT_SECRET,
    },
    reachable: SANDBOX,
    unreachable: "github-app-1.cf-one.gone",
  } satisfies Subject;
});

const BOXD_KEY = "bxd_contract_key";
const MACHINE = MachineId.make("vm-contract");

/** The boxd shell, with an `Exec` endpoint whose one machine runs commands here. */
const boxdShell = Effect.gen(function* () {
  const server = yield* fakeBoxdExec({ credential: BOXD_KEY, machines: new Set([MACHINE]) });
  return {
    ssh: {
      command: process.execPath,
      args: ["--no-warnings", source("../../src/ssh/provisioner/boxd/shell/shell.ts")],
    },
    environment: {
      [BOXD_SHELL_ENVIRONMENT.endpoint]: server.url,
      [BOXD_SHELL_ENVIRONMENT.credential]: BOXD_KEY,
    },
    reachable: MACHINE,
    unreachable: "vm-gone",
  } satisfies Subject;
});

/** Listens on a free local port until the scope closes and returns the server's origin. */
const listen = (
  server: ReturnType<typeof createServer>,
): Effect.Effect<string, never, Scope.Scope> =>
  Effect.gen(function* () {
    yield* Effect.acquireRelease(
      Effect.callback<void>((resume) => {
        server.listen(0, "127.0.0.1", () => resume(Effect.void));
      }),
      () =>
        Effect.callback<void>((resume) => {
          server.closeAllConnections();
          server.close(() => resume(Effect.void));
        }),
    );
    const address = server.address();
    if (address === null || Predicate.isString(address))
      return yield* Effect.die(new Error("the server has no port"));
    return `http://127.0.0.1:${address.port}`;
  });

/** Runs `line` through the subject's program as `RemoteShell` runs it. */
const runThrough = (
  subject: Subject,
  destination: string,
  line: string,
  options: { readonly stdin?: Uint8Array; readonly sshOptions?: ReadonlyArray<string> } = {},
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const path = yield* Config.String("PATH").pipe(Config.withDefault("/usr/bin:/bin"));
    const handle = yield* spawner.spawn(
      ChildProcess.make(
        subject.ssh.command,
        [...subject.ssh.args, ...(options.sshOptions ?? []), destination, "--", line],
        {
          stdin: Stream.make(options.stdin ?? new Uint8Array()),
          env: { PATH: path, ...subject.environment },
          extendEnv: false,
        },
      ),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        handle.stdout.pipe(Stream.runCollect),
        handle.stderr.pipe(Stream.runCollect),
        handle.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    return {
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
      exitCode: Number(exitCode),
    };
  }).pipe(Effect.scoped);

const subjects = [
  { name: "a fake OpenSSH client", setup: fakeOpenSsh },
  { name: "the Cloudflare sandbox shell", setup: cloudflareShell },
  { name: "the boxd shell", setup: boxdShell },
] as const;

for (const { name, setup } of subjects) {
  describe(`the SshCommand contract: ${name}`, () => {
    const test = <A, E>(
      title: string,
      body: (
        subject: Subject,
      ) => Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner | Scope.Scope>,
    ) =>
      it.live(title, () =>
        Effect.gen(function* () {
          const subject = yield* setup;
          return yield* body(subject);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      );

    test("exits with the command's exit code", (subject) =>
      Effect.gen(function* () {
        const result = yield* runThrough(subject, subject.reachable, "exit 7");
        assert.strictEqual(result.exitCode, 7);
      }));

    test("relays stdout and stderr apart, byte for byte", (subject) =>
      Effect.gen(function* () {
        const result = yield* runThrough(
          subject,
          subject.reachable,
          "printf 'out\\000\\377\\n'; printf 'err\\001' >&2",
        );
        assert.deepStrictEqual([...result.stdout], [...Buffer.from("out\0\xff\n", "latin1")]);
        assert.deepStrictEqual([...result.stderr], [...Buffer.from("err\x01", "latin1")]);
        assert.strictEqual(result.exitCode, 0);
      }));

    test("writes stdin to the command until it ends, which closes the command's stdin", (subject) =>
      Effect.gen(function* () {
        const input = Uint8Array.from({ length: 1024 * 1024 + 7 }, (_, index) => (index * 7) % 256);
        const result = yield* runThrough(subject, subject.reachable, "cat; echo done >&2", {
          stdin: input,
        });
        assert.isTrue(Buffer.from(input).equals(result.stdout));
        assert.strictEqual(result.stderr.toString(), "done\n");
        assert.strictEqual(result.exitCode, 0);
      }));

    test("accepts and ignores the -o options that usine adds", (subject) =>
      Effect.gen(function* () {
        const result = yield* runThrough(subject, subject.reachable, "echo ok", {
          sshOptions: ["-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=30"],
        });
        assert.strictEqual(result.stdout.toString(), "ok\n");
        assert.strictEqual(result.exitCode, 0);
      }));

    test("exits 255 when it can't reach the machine", (subject) =>
      Effect.gen(function* () {
        const result = yield* runThrough(subject, subject.unreachable, "true");
        assert.strictEqual(result.exitCode, TRANSPORT_FAILURE);
        assert.strictEqual(result.stdout.length, 0);
        assert.isAbove(result.stderr.length, 0);
      }));
  });
}

describe("parseStandInArguments", () => {
  it("reads the destination and the command line after -o options", () => {
    assert.deepStrictEqual(
      parseStandInArguments(["-o", "ConnectTimeout=10", "vm-1", "--", "exec 'true'"]),
      Option.some({ destination: "vm-1", line: "exec 'true'" }),
    );
    assert.deepStrictEqual(
      parseStandInArguments(["vm-1", "--", "-- --"]),
      Option.some({ destination: "vm-1", line: "-- --" }),
    );
  });

  it("refuses other options, a missing destination, and more than one command line", () => {
    for (const args of [
      ["-p", "22", "vm-1", "--", "true"],
      ["-o", "vm-1", "--", "true"],
      ["--", "true"],
      ["vm-1", "--"],
      ["vm-1", "--", "true", "false"],
      ["vm-1", "true"],
      ["-x", "--", "true"],
    ])
      assert.isTrue(Option.isNone(parseStandInArguments(args)), args.join(" "));
  });
});

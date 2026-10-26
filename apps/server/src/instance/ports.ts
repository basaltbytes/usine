import { Effect, FileSystem, Option, type PlatformError, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Port } from "../cli.ts";
import { ProcessId } from "./record.ts";

const LSOF_TIMEOUT = "2 seconds";
/** The `st` column of a listening socket in `/proc/<pid>/net/tcp`. */
const TCP_LISTEN = "0A";
const SOCKET_LINK = /^socket:\[(\d+)\]$/u;

/** The OS couldn't list the TCP ports that a process listens on. */
export class ListeningPortsError extends Schema.TaggedError<ListeningPortsError>(
  "@usine/server/ListeningPortsError",
)("ListeningPortsError", { pid: ProcessId, reason: Schema.String }) {}

/** Returns the port after the last colon of a socket address, in base `radix`. */
const addressPort = (address: string, radix: 10 | 16) =>
  Option.toArray(
    Schema.decodeUnknownOption(Port)(
      Number.parseInt(address.slice(address.lastIndexOf(":") + 1), radix),
    ),
  );

/** Returns the inode and port of each listening socket in a `/proc/<pid>/net/tcp` table. */
const listeningSockets = (table: string) =>
  table
    .split("\n")
    .slice(1)
    .flatMap((line) => {
      const [, local, , state, , , , , , inode] = line.trim().split(/\s+/u);
      if (state !== TCP_LISTEN || local === undefined || inode === undefined) return [];
      return addressPort(local, 16).map((port) => ({ inode, port }));
    });

/**
 * Lists the IPv4 TCP ports that the process listens on, from its file descriptors and its network
 * namespace's socket table in `/proc`. Linux only. Fails if this user may not read them.
 */
export const procListeningPorts = Effect.fn("Instance.procListeningPorts")(function* (
  pid: ProcessId,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const failure = (error: PlatformError.PlatformError) =>
    new ListeningPortsError({ pid, reason: error.message });
  const descriptors = yield* fileSystem
    .readDirectory(`/proc/${pid}/fd`)
    .pipe(Effect.mapError(failure));
  const inodes = new Set<string>();
  for (const descriptor of descriptors) {
    const target = yield* fileSystem.readLink(`/proc/${pid}/fd/${descriptor}`).pipe(
      Effect.tapError((error) =>
        Effect.logDebug("Skipped a descriptor that the process may have closed after the listing", {
          pid,
          descriptor,
          reason: error.message,
        }),
      ),
      Effect.option,
    );
    const inode = Option.flatMapNullishOr(target, (link) => SOCKET_LINK.exec(link)?.[1]);
    if (Option.isSome(inode)) inodes.add(inode.value);
  }
  const table = yield* fileSystem
    .readFileString(`/proc/${pid}/net/tcp`)
    .pipe(Effect.mapError(failure));
  const ports = listeningSockets(table)
    .filter(({ inode }) => inodes.has(inode))
    .map(({ port }) => port);
  return [...new Set(ports)];
});

/**
 * Lists the IPv4 TCP ports that the process listens on, from lsof. Fails if lsof is missing or
 * doesn't answer in time. Returns no ports for a process that lsof may not inspect.
 */
export const lsofListeningPorts = Effect.fn("Instance.lsofListeningPorts")(function* (
  pid: ProcessId,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // -a selects the sockets that match every option, not any of them.
  const lines = yield* spawner
    .lines(
      ChildProcess.make("lsof", ["-a", "-nP", "-p", String(pid), "-i4TCP", "-sTCP:LISTEN", "-Fn"], {
        stdin: "ignore",
        stderr: "ignore",
      }),
    )
    .pipe(
      Effect.timeoutOrElse({
        duration: LSOF_TIMEOUT,
        orElse: () =>
          Effect.fail(new ListeningPortsError({ pid, reason: `lsof took over ${LSOF_TIMEOUT}` })),
      }),
      Effect.catchTag("PlatformError", (error) =>
        Effect.fail(new ListeningPortsError({ pid, reason: error.message })),
      ),
    );
  // With -Fn, lsof names each socket on a line like `n127.0.0.1:7331`.
  const ports = lines
    .filter((line) => line.startsWith("n"))
    .flatMap((line) => addressPort(line, 10));
  return [...new Set(ports)];
});

/** Lists the IPv4 TCP ports that the process listens on: from `/proc` on Linux, else from lsof. */
export const listeningPorts = Effect.fn("Instance.listeningPorts")(function* (pid: ProcessId) {
  const ports =
    process.platform === "linux" ? yield* procListeningPorts(pid) : yield* lsofListeningPorts(pid);
  yield* Effect.annotateCurrentSpan({ pid, ports });
  return ports;
});

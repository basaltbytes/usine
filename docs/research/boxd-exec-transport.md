# boxd exec stream as the remote transport

Research for [issue #1106](https://github.com/basaltbytes/usine/issues/1106): can boxd's gRPC
`Exec` stream replace SSH as the way the `ssh` worker kind runs commands and children on a boxd
machine? Snapshot date: 2026-11-10.

The SSH path through boxd's proxy needs a key linked to the boxd account, and boxd refuses
`LinkSshKey` from an API key ([#1121](https://github.com/basaltbytes/usine/issues/1121)). `Exec`
needs only the API key that the driver already holds. This note measures `Exec` against the
operations of `RemoteMachine` (`packages/executor/src/remote/machine.ts`) and recommends a
transport.

## Method

All numbers marked **measured** come from probes run on 2026-11-10 against boxd's hosted `fra`
region. Numbers marked **quoted** come from earlier issues and pull requests, with the source named.

- Client: a macOS workstation with Node.js 24.22.2, `@boxd-sh/sdk` 0.3.0, and the SDK's bundled
  `@grpc/grpc-js` 1.14.7. TCP connect time from the client to both `fra.boxd.sh:9443` and the SSH
  proxy was 29 ms (median of 10).
- Machines: five machines restored from the `usine-attempt` snapshot (2 vCPU, 8 GiB, Ubuntu
  24.04.5, kernel 6.18), isolated, named `probe-1106-a` to `probe-1106-e`, at most two at a time,
  with auto-suspend and auto-hibernate off as the driver sets them. All five were deleted after the
  probes. At the metered rates (EUR 0.039 per vCPU-hour and EUR 0.012 per GiB-hour), such a machine
  costs about EUR 0.17 per hour.
- Authentication: the API key as the bearer of every call, except where the SDK chose its own path.
- No linked SSH key was available to the probes, so no SSH command ran on a probe machine. The SSH
  column below uses the handshake floor that needs no key, plus findings quoted from
  [#1101](https://github.com/basaltbytes/usine/issues/1101) and #1121.

The probe scripts are in [`boxd-exec-transport/`](./boxd-exec-transport/). They read
`BOXD_API_KEY` and `BOXD_SDK_DIR` from the environment, refuse to touch a machine whose name doesn't
start with `probe-1106-`, and never print the key.

| Script | Measures |
| --- | --- |
| `create.mjs` | Restore from the snapshot, then the first successful `exec`. |
| `latency.mjs` | Warm unary `exec` and `streamExec` latency; a fresh SDK client per call. |
| `cold.mjs` | One `exec` from a fresh process and connection, the cost of an `ssh` stand-in. |
| `ssh-floor.mjs` | TCP connect times, and an SSH session up to the refused `none` authentication. |
| `basics.mjs` | Exit codes, signals, stderr, working directory, environment, process groups. |
| `framing.mjs`, `framing2.mjs` | NDJSON ordering, large lines, binary data, throughput, backpressure, message size. |
| `window.mjs`, `h2window.mjs` | Output throughput against the client's HTTP/2 receive windows. |
| `channels.mjs` | Throughput over separate connections; 50 and 200 concurrent streams. |
| `idle.mjs` | Streams idle for 12 minutes, then active until minute 40; one command silent for 40 minutes. |
| `reattach-start.mjs`, `reattach-check.mjs` | Which processes outlive a dead client, and a new stream reading their output. |
| `endpoints.mjs` | Routing by endpoint and machine name; errors for a bad key and an unknown machine. |
| `egress.mjs` | `Exec` with the egress allowlist set to `none`. |
| `destroy-under-stream.mjs` | How a running stream ends when its machine is deleted. |

## The Exec RPC

`/boxd.api.v1.BoxdApi/Exec` is a bidirectional stream of `ExecChunk` messages
([sdk], `dist/_generated/api.d.ts`). Its fields are `data`, `stdin`, `tty`, `command`, `vm_id`,
`exit_code`, `cols`, `rows`, `window_change`, `is_stderr`, and `device_id`.

- The first client message carries `vm_id` (a machine id or name) and `command`, a command line.
  Later client messages carry stdin bytes or a terminal resize. Half-closing the request stream
  closes the command's stdin.
- The server sends stdout and stderr chunks, marked by `is_stderr`, then one final chunk with empty
  `data` and `exit_code`.
- The message has no field for environment variables, the working directory, or the user. The
  SDK's `env` and `cwd` options prefix the command line with `NAME=value` assignments and
  `cd <dir> &&` (`commandLine` in `dist/machines.js`, [sdk]).
- The proto comment says that cancelling the call, or "the caller half-closing/cancelling the
  stream", kills the command's process group. Measured: half-closing only closes stdin; cancelling
  kills (see [Process lifetime](#process-lifetime-and-reattachment)).

## Authentication and endpoints

**Measured.**

- `Exec` accepts the API key itself as the bearer on `fra.boxd.sh:9443` and on the account endpoint
  `boxd.sh:9443`. No token exchange is needed.
- 40 calls, each from a fresh process with a new TLS connection and the API key as the bearer, ran
  in 11 seconds without a refusal. The SDK documents a limit of 30 token exchanges per 60 seconds
  per source IP ([sdk], README "Authentication"); the API key as the bearer didn't meet a limit at
  that rate.
- `ListRegions` lists `fra` at `https://fra.boxd.sh:9443` and `nyc` at `https://nyc.boxd.sh:9443`.
  The account endpoint routes `Exec` to a `fra` machine; the `nyc` endpoint answers `NOT_FOUND`,
  "VM not found (region nyc)".
- A machine name works in `vm_id` as well as its id.
- Errors before the command starts arrive as gRPC statuses: `UNAUTHENTICATED` ("API key not
  recognized: it was deleted, or it is not a key of this cluster") for a bad key, `NOT_FOUND` ("VM
  not found (region fra)") for an unknown machine.

SDK 0.3.0 sends the key itself after a `Whoami` probe on each new connection and exchanges it only
when a server refuses it (`DirectKey` in `dist/auth.js`, [sdk]). Whether boxd supports the key as
a bearer is question 3 of [`boxd-byoc.md`](./boxd-byoc.md#questions-for-boxd).

## Startup latency

**Measured**, in milliseconds.

| Path | Median | Range | Runs |
| --- | --- | --- | --- |
| `CreateVmFromSnapshot` call returns (status already `running`) | 482 | 391 to 506 | 5 |
| Create call start to first successful `exec` of `true` | 640 | 520 to 652 | 5 |
| Unary `exec` of `true` on a warm connection | 72 | 31 to 103 | 20 |
| `streamExec` of `echo hi`, first stdout byte | 73 | 33 to 94 | 20 |
| `streamExec` of `echo hi`, exit | 74 | 33 to 95 | 20 |
| New SDK client in the same process, then `exec` of `true` | 325 | 290 to 366 | 10 |
| New process, new connection, `Exec` of `true` (an `ssh` stand-in) | 261 | 223 to 321 | 40 |
| SSH through the proxy up to the refused `none` authentication, no key | 221 | 196 to 263 | 10 |

The first `exec` succeeded on its first try in all five restores. The time to first `exec`
includes the two calls that turn off auto-hibernate and auto-suspend.

The SSH row is a floor: TCP, the server banner, key exchange, and a refused authentication. A real
command adds public-key authentication, a channel, and the command, so each `ssh` invocation costs
more than 221 ms. usine's `DEFAULT_SSH` opens one connection per command, without connection
sharing. A full SSH command and SSH readiness after a restore couldn't be measured without a linked
key.

## Throughput and framing

**Measured** with a long-lived `Exec` of `cat`, the shape of the child host's process owner relay,
which reads newline-delimited JSON frames on stdin and writes them on stdout.

| Test | Result |
| --- | --- |
| 20,000 NDJSON lines of 100 bytes, one `ExecChunk` each | All received in order, 1.47 s, 13,600 lines per second. |
| Lines of 1 MB, 8 MB, and 32 MB, sent in 64 KiB chunks | Byte-exact. |
| 1 MB of every byte value, 0 to 255 | Byte-exact. |
| stdout and stderr | Separate: stderr chunks have `is_stderr`. |
| Server output chunk size | At most 4,096 bytes of `data` per chunk. |
| Output, client receive window at the HTTP/2 default (64 KiB) | 1.3 MB/s per stream; 1.6 MB/s for 4 streams on one connection; 4.4 MB/s for 4 streams on 4 connections. |
| Output, 1 MiB window | 14 to 20 MB/s for one stream. |
| Output, 8 MiB window | 32 to 61 MB/s for one stream; 64 MB/s for 4 streams on one connection. |
| Output, 32 MiB window | Same as 8 MiB. |
| Input, 64 MB to `cat >/dev/null` | 3.8 s, about 18 MB/s. |
| Backpressure, 128 MB to a command that reads nothing for 10 s | `write()` returned `false` 128 times and waited for `drain`; the client's memory didn't grow. |
| One stdin `ExecChunk` with 4,194,240 bytes of data | Delivered. |
| One stdin `ExecChunk` with 4,194,304 bytes or more | The command's stdin closes at that point: earlier chunks arrive, this one and every later one are dropped, the command exits 0, and the call ends without an error status. |

The output limit is the client's HTTP/2 flow control, not boxd. `h2window.mjs` separates the two
windows: raising the stream window in the HTTP/2 `SETTINGS` alone leaves the rate at 1.3 MB/s, and
raising the connection window with `session.setLocalWindowSize()` lifts it to 41 MB/s. grpc-js sets
both through its `grpc-node.flow_control_window` channel option. The SDK sets neither, so its
`exec` and `streamExec` read 8 MB in 6.4 and 6.8 seconds. `@connectrpc/connect-node` 2.3.0,
which usine's boxd client uses, takes `http2.SecureClientSessionOptions` for the stream window but
never calls `setLocalWindowSize`.

The SDK's `ExecStream.write()` ignores the result of grpc-js `write()`, so a fast writer buffers
without bound in the client (`dist/machines.js`, [sdk]).

**Quoted** from #1101 for SSH through the proxy: stdin piped to the remote command, 8 MB on stdin,
stdout and stderr separation, and the exit code all work. SSH throughput wasn't measured.

## Process lifetime and reattachment

**Measured.**

- Each command runs as `/bin/sh -c <command line>` (`dash`) as user `boxd` (uid 1000, groups
  including `sudo` and `docker`), in its own session and process group (PID, PGID, and SID are
  equal), with parent PID 0 and the root cgroup (`0::/`). stdin and stdout are pipes unless `tty` is
  set.
- The environment has `HOME`, `PATH`, `SHELL`, `TERM`, `USER`, `XDG_RUNTIME_DIR`,
  `SYSTEMD_IGNORE_CHROOT`, and boxd's own variables: `BOXD_IDENTITY`, `BOXD_VM_HOST`, `BOXD_VM_ID`,
  `BOXD_VM_NAME`, `boxd_exec_port` (57073), `boxd_gateway`, `boxd_ip`, `boxd_nameserver`,
  `boxd_netmask`, `boxd_vm_id`, `boxd_vm_name`. `BOXD_IDENTITY` is a 160-character value on an
  isolated machine; its purpose isn't documented.
- Exit codes: the command's own code (`exit 7` gives 7); a shell killed by a signal gives 128 plus
  the signal number (143 for `TERM`, 137 for `KILL`). A missing directory in a `cd` prefix fails
  with the shell's exit code 2.
- A variable passed as a command-line prefix, as the SDK's `env` does, is visible to every process
  in the machine through `ps` for the life of the command.
- When the command's leader exits, the stream ends at once. Output that a background process
  writes later is lost (`(sleep 1; echo late) & echo early` returns only `early`), and the
  background process keeps running. OpenSSH keeps a session open until every writer closes its
  output.

Three ways for the client to die were tested: `SIGKILL` of the client process, `cancel()` of the
call, and closing the connection followed by process exit. A second process started checking right
after the client exited, every 250 ms. All three had the same effect:

| Process started by the command | After the client died |
| --- | --- |
| The leader shell, which traps `TERM` | Had received `TERM` at the first check (0.2 s), and was gone 2.5 to 3.2 s after the check started. |
| A background child in the same process group | Gone at the first check. |
| `nohup sleep` in the same process group | Gone at the first check. |
| A process started with `setsid` | Kept running. |
| A Node.js child spawned with `detached: true` | Kept running. |

A new `Exec` stream read the output file of the `setsid` process (`tail -f`) after each client
death, from the same endpoint and from a new connection.

This matches usine's process owner (`packages/agents/src/child-host/worker/`): the relay runs as
the stream's command, and it spawns the supervisor with `detached: true`, which calls `setsid`. So a
dropped stream ends the relay and leaves the supervisor, its journal, and the harness running, and
the next relay attaches to them, as it does after an SSH drop (ADR 0013, amendment for the
2026-10-26 sleeps). #1101 found that the SSH proxy runs commands through the same in-machine agent
(`boxd_exec_port`, parent PID 0), so the teardown is probably the same over SSH; that wasn't
measured.

Deleting a machine under a running stream ends the stream at once with `UNAVAILABLE`: "lost the
connection to the machine during exec: the machine was destroyed". A later `GetVm` answers
`NOT_FOUND`.

## Idle and long streams

**Measured** with `idle.mjs` on one machine, four streams opened at the same time on separate
connections:

| Stream | Traffic | Result |
| --- | --- | --- |
| Raw `Exec` of `cat`, no HTTP/2 keepalive | One line at start, none for 12 minutes, then one line every 30 s until minute 40 | Every line echoed, 57 of 57. Ended with exit code 0 when the client closed stdin at minute 40. |
| Raw `Exec` of `cat`, HTTP/2 keepalive every 30 s | Same | Same: 57 of 57, exit code 0. |
| SDK `streamExec` of `cat` | Same | Same: 57 of 57, exit code 0. |
| Raw `Exec` of `sleep 2400; echo silent-done`, no keepalive | None in either direction | The output due at minute 40 never arrived. When the client half-closed the stream at minute 40.05, the call failed 24 s later with `UNAVAILABLE` "read ETIMEDOUT". |

So a stream survived 12 idle minutes and lived for 40 minutes with traffic, and no server-side
limit on stream duration showed up. A connection with no traffic at all for 40 minutes was dropped
somewhere on the path without either end noticing, and the client found out only when it wrote.
The probe can't tell whether boxd, its load balancer, or the client's own network dropped it, or
when between minute 12 and minute 40. The SDK documents no keepalive and sets none.

usine's process owner relay sends a heartbeat line every second, so its streams never go quiet.
An `ssh` stand-in still needs HTTP/2 keepalive pings, as `DEFAULT_SSH` sets `ServerAliveInterval`,
so that a dead connection fails within a bounded time instead of at the next write.

## Egress allowlist and isolated machines

**Measured** on an isolated machine with `SetVmEgressAllow` set to `["none"]`: `curl
https://example.com` fails to resolve the host, while unary `Exec`, a raw stream with stdin, and the
SDK's `streamExec` work as before. The allowlist was cleared afterwards. The SDK also states that
`exec` works with SSH turned off on the machine (`setSsh`, README "Machines", [sdk]).

## Limits

| Limit | Value | Source |
| --- | --- | --- |
| Token exchange rate | 30 per 60 s per source IP; a session lasts 1 hour. | Quoted: SDK README. |
| Calls with the API key as the bearer | No refusal at 40 new connections in 11 s. | Measured. |
| Concurrent streams on one machine, one connection | 200 streams of `sleep 20` all exited 0. | Measured. |
| stdin `ExecChunk` size | Under 4 MiB of `data`; larger closes stdin silently. | Measured. |
| Output chunk size | 4,096 bytes. | Measured. |
| Exec timeout | None documented. The SDK sets no deadline on `Exec`; its 30-minute timeout applies to package installs in a machine spec. | Quoted: SDK `dist/_transport.js`, README "Packages". |
| Stream duration | Streams with traffic lasted 40 minutes; a connection silent for 40 minutes was dropped. | Measured. |
| Grace between `TERM` and `KILL` on teardown | About 3 s. | Measured; the proto says "a short grace period". |

For an orchestrator, the exchange limit matters only when each command exchanges the key. An `ssh`
stand-in that starts a process per command can't share a session token in memory. With the key as
the bearer it needs no exchange; with an exchange per process, a few attempts would exceed 30 per
minute.

## SSH and exec per operation

The operations are those of `RemoteMachine` and the code that reaches a machine through its
`RemoteShell`.

| Operation | SSH through the boxd proxy | gRPC `Exec` |
| --- | --- | --- |
| Authentication | The worker key must be linked to the boxd account from a signed-in session (#1121). The proxy's host key is pinned from `ListVms.ssh_host_key`. | The API key on every call; the endpoint's TLS certificate. Nothing on the machine or the account to prepare. |
| Readiness after restore (`awaitMachineSsh`) | `READY_SCRIPT` over SSH until it answers. Not measured; each try costs more than the 221 ms floor. | The first `exec` answered 520 to 652 ms after the create call started. |
| One command (`RemoteCommands.inspect`, `run`) | One `ssh` process and connection per command; more than 221 ms each. | 261 ms from a new process; 72 ms on a warm connection in the orchestrator. |
| Command with secrets (`runWithInput`, `sendingShell`) | The stdin environment block (#1107), because the proxy drops `SendEnv`. | The same stdin block. The wire has no environment field, and a command-line prefix is visible through `ps`. |
| Exit status | The command's code, or 255 when `ssh` fails; a command that exits 255 looks like a transport failure. | The final chunk's `exit_code`; a transport failure is a gRPC status, so the two never mix. |
| Child process stream (`remoteProcess`, process owner relay) | stdin and stdout of `ssh`. Works with 8 MB on stdin (quoted, #1101); throughput not measured. | One bidirectional stream; ordered; binary-safe; 30 to 60 MB/s out with an 8 MiB connection window, 1.3 MB/s without; stdin messages under 4 MiB. |
| Stream loss | The proxy's agent ends the command (inferred from #1101, not measured). | `TERM` to the process group, `KILL` about 3 s later; `setsid` processes survive (measured). |
| Reattachment after an orchestrator restart | The process owner relay reconnects over a new `ssh` and attaches. | The same relay over a new stream; a new stream read a surviving process's output (measured). |
| Liveness probe (`probe`, ADR 0013) | `true` over a new SSH connection every minute; on failure, `GetVm` for a new proxy port (`refreshEndpoint`, `connection.ts`). | `true` over a new stream. The machine id never changes, so there's no endpoint to refresh. A deleted machine reports `UNAVAILABLE` "the machine was destroyed" on a running stream and `NOT_FOUND` on a new one. |
| Endpoint changes | A per-machine OpenSSH config file rewritten by atomic rename, with the host key under an alias. | None. The region's API endpoint comes from `ListRegions`, which the driver already reads. |
| Isolated machine, egress set to `none` | Not measured. | Works (measured). |
| Attempt container (`RemoteShell.container`) | `docker exec -i` inside the command line. | The same command line; the `boxd` user is in the `docker` group. |
| Gateway as SSH jump host (`-J` when `egress` isn't `direct`) | Available. | Not available; boxd workers join the gateway's tailnet instead. |
| Machine with SSH turned off | Not reachable. | Reachable (quoted, SDK README). |

## A RemoteMachine adapter over Exec

The Cloudflare worker kind already runs every command through a program that stands in for `ssh`:
`packages/executor/src/cloudflare/shell/shell.ts` takes `[options] <sandbox> -- <command>`,
relays stdin, stdout, and stderr over the Worker's exec stream, and exits with the command's code,
or 255 when it can't reach the sandbox. `cloudflare.ts` sets it as the `SshCommand` of each
`RemoteShell`, with `process.execPath` as the command, and puts its credentials in
`sshEnvironment`. The child host, the process owner, `RemoteCommands`, and every caller of the shell
are unchanged.

A boxd adapter can take the same seam:

- **A boxd shell program** next to the generated client, in `ssh/provisioner/boxd/`: it parses
  `[options] <machine id> -- <command line>`, ignores OpenSSH options such as the `ConnectTimeout`
  that `awaitMachineSsh` adds, opens `Exec` on the region's endpoint, and relays the standard
  streams. It raises the HTTP/2 connection window to at least 8 MiB, sends stdin in chunks of
  64 KiB or less with backpressure, sets an HTTP/2 keepalive, and exits with the final chunk's
  `exit_code`, or 255 on any gRPC status. Its environment carries the endpoint and the credential
  and never appears in its arguments. connect-node doesn't raise the connection window, so the
  program uses grpc-js or a session that it can call `setLocalWindowSize` on.
- **The proto projection** (`proto/api.proto`, regenerated with `pnpm boxd:generate`) gains
  `ExecChunk` and the `Exec` RPC.
- **`MachineEndpoint`** in `provisioner/model.ts` describes an SSH address today: a destination, a
  port, and a host key. It becomes a union of that and an exec endpoint (a machine id and an API
  endpoint), and `machineAt` in `workers.ts` builds the `RemoteShell` for either. `machineOf` in
  `machines.ts` pins a host key only for the SSH variant.
- **The boxd driver** (`provisioner/boxd.ts`) returns the exec endpoint, drops `proxyKey` and
  `sshHostKey`, and creates machines with SSH turned off. `refreshEndpoint` answers `None` for a
  machine that is gone and the same endpoint otherwise, so `connection.ts` writes no OpenSSH config
  for it.
- **Configuration**: `identity_file` no longer applies to a boxd worker, and the guide loses the
  key and snapshot steps that exist for SSH.

What stays: `RemoteShell`, `sshArguments`, `sshInput` and its stdin environment block, the process
owner and its relay, `RemoteCommands`, `remote.ts`, the liveness watch, the gateway tailnet join,
and the container path.

The other seam is a transport port in `@usine/agents/child-host` with an OpenSSH adapter and an
in-process `Exec` adapter, called where `hostCommand` now spawns `ssh`. It saves the process start
and the TLS handshake on each command (261 ms against 72 ms) and keeps the credential out of child
process environments, but it changes the child host's contract for every worker kind, on the
critical path. The shell program reaches the same transport without that change.

The credential in the shell's environment has two candidates:

- **The API key as the bearer.** Measured to work without an exchange and without a limit at the
  rate tested. boxd doesn't document it (question 3 of `boxd-byoc.md`).
- **A session token from the orchestrator's exchange.** It expires after an hour, but a
  `RemoteShell` keeps the environment it was built with, and a relay reconnects with it. The shell
  would read the token from a file that the orchestrator rewrites by atomic rename, as
  `connection.ts` does for OpenSSH config.

The API key in a child process's environment is readable by the orchestrator's own user through
`ps eww` or `/proc/<pid>/environ`, as the Cloudflare Access secret already is. The machines never
see it.

## Risks

- **Undocumented bearer.** If boxd stops accepting the API key as the bearer, each shell process
  needs a token from a shared source, or the 30-per-minute exchange limit stops attempts.
- **Silent stdin truncation.** A client that sends 4 MiB or more in one `ExecChunk` loses input
  without an error, and the command exits 0. The shell has to chunk, and a test has to pin it.
- **Flow control.** Without a raised connection window, harness output runs at 1.3 MB/s per
  stream and 1.6 MB/s for all streams on one connection. The process owner base64-encodes output,
  so a large tool result or a long transcript replay takes seconds.
- **Silent connection loss.** A connection with no traffic was dropped without either end
  noticing. Without HTTP/2 keepalive, a command that waits without output, such as a long
  `git fetch` through the shell, can hang until the client writes.
- **Output after the leader exits.** The stream doesn't wait for background writers. usine's
  commands `exec` their program or wait for it, but a new command that backgrounds a writer loses
  its output without an error.
- **SDK behavior.** usine doesn't use the SDK, but its `streamExec` buffers stdin without bound and
  reads at 1.3 MB/s, so it isn't a fit for the transport as published.
- **One provider.** The transport serves boxd only. Hetzner, Boat, and fixed machines keep SSH,
  so the SSH path stays fully tested.

## Questions for boxd

These continue the numbered list in [`boxd-byoc.md`](./boxd-byoc.md#questions-for-boxd), which was
sent with questions 1 to 12.

13. Is `Exec` with an API key as the bearer rate-limited, per key or per source IP, and at what
    rate?
14. Is there a maximum duration or idle timeout for an `Exec` stream, at the API, the proxy, or the
    load balancer? Which keepalive interval does the server accept?
15. An `ExecChunk` with 4 MiB or more of stdin `data` closes the command's stdin, and the call ends
    with exit code 0 and no error. Is 4 MiB the server's message limit, and can it answer
    `RESOURCE_EXHAUSTED` instead?
16. Can `Exec` wait for stdout and stderr to close before it sends the final chunk, as OpenSSH
    does, or is ending at the leader's exit the intended behavior?
17. What is the grace period between `SIGTERM` and `SIGKILL` when a stream is torn down (about
    3 s measured), and is it stable?
18. Will `ExecChunk` get fields for environment variables, the working directory, or the user, so
    that secrets don't go on the command line or stdin?
19. What is `BOXD_IDENTITY` in the environment of an `Exec` command on an isolated machine, and can
    a process in the machine use it to call boxd?
20. Does the SSH proxy run commands with the same teardown as `Exec`: `SIGTERM` to the process
    group on disconnect, and the session ending at the leader's exit?
21. On a self-hosted cluster or a deployment in the operator's account, does `Exec` need anything
    beyond the API port 9443 (TCP), given that only boxd reaches the agent port 57073?
22. Does an open `Exec` stream count as activity for auto-suspend and auto-hibernate?

Question 35 came after the list in
[`boxd-attempt-machine-sources.md`](./boxd-attempt-machine-sources.md#questions-for-boxd), which
ends at 34.

35. When boxd deletes the machine of a running `Exec` stream, the call ends with `UNAVAILABLE` and
    "lost the connection to the machine during exec: the machine was destroyed". usine tells a
    deleted machine from a dropped connection by the text "the machine was destroyed". Can boxd
    end the call with a distinct status, such as `NOT_FOUND`, or an error detail, or keep that text
    stable?

## Recommendation

Replace SSH with `Exec` for boxd workers, and keep no SSH fallback for them.

- `Exec` removes the operator step that SSH needs on every boxd account (#1121), and with it the
  worker key in the snapshot, the proxy host key pin, the endpoint refresh for changing proxy
  ports, and the `SendEnv` question. A customer's own boxd account then needs only an API key.
- Every measured operation works: commands start in 72 ms on a warm connection and 261 ms from a
  new process, against an SSH floor of 221 ms before authentication; the child host's stream is
  ordered, binary-safe, and backpressured; the process owner survives a dead stream and a new
  stream reaches it; isolated machines with egress set to `none` answer.
- A boxd fallback to SSH would keep the operator step and a second boxd test matrix for a path
  that the measurements don't need. The operator chose one variable transport over two for #1107
  for the same reason.

Build it as the shell program described above, the seam the Cloudflare kind already uses, with
three requirements that the probes found: a raised HTTP/2 connection window, stdin chunks under
4 MiB, and a mapping of every gRPC status to exit code 255. Pass the API key as the bearer, and
ask boxd question 3 of `boxd-byoc.md` and question 13 here before relying on it; if boxd answers
no, the shell reads a session token from a file that the orchestrator renews. Hetzner, Boat, and
fixed machines stay on SSH. Until the exec transport ships, #1121's link step is what lets a boxd
worker run an attempt.

## Sources

- `@boxd-sh/sdk` 0.3.0 on npm ([sdk]): `README.md` sections "Authentication", "Machines", "Exec",
  "Egress allowlist", and "Usage and cost"; `dist/machines.js`, `dist/exec.js`,
  `dist/_transport.js`, `dist/auth.js`, `dist/_generated/api.d.ts`, and
  `dist/_generated/definitions.js`.
- usine: `packages/executor/src/remote/` (`machine.ts`, `commands.ts`, `liveness.ts`),
  `packages/executor/src/ssh/` (`workers.ts`, `provisioner/boxd.ts`, `provisioner/boxd/`,
  `provisioner/machines.ts`, `provisioner/connection.ts`, `provisioner/checks.ts`),
  `packages/executor/src/cloudflare/shell/shell.ts`, `packages/agents/src/child-host/`, ADR 0013,
  ADR 0029, and [`boxd-byoc.md`](./boxd-byoc.md).
- Issues and pull requests: [#1101](https://github.com/basaltbytes/usine/issues/1101),
  [#1107](https://github.com/basaltbytes/usine/pull/1107), and
  [#1121](https://github.com/basaltbytes/usine/issues/1121).

[sdk]: https://www.npmjs.com/package/@boxd-sh/sdk/v/0.3.0

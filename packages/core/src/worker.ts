import { Schema } from "effect";

/** Kebab-case name of a configured Worker. */
export const WorkerName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, {
    message: "Expected a kebab-case Worker name",
  }),
).pipe(Schema.brand("WorkerName"));

export type WorkerName = typeof WorkerName.Type;

/** The Worker kinds the engine has an adapter for. */
export const WORKER_KINDS = ["local", "exe.dev", "ssh"] as const;
export const WorkerKind = Schema.Literals(WORKER_KINDS);
export type WorkerKind = typeof WorkerKind.Type;

/**
 * Where the local `ssh` client connects: a host name, an address, or a Host
 * alias from the operator's SSH configuration, optionally prefixed by a user.
 * It is passed to `ssh` as one argument, so a value that could read as an
 * option (`-oProxyCommand=...`) cannot be constructed.
 */
export const SshDestination = Schema.String.check(
  Schema.isPattern(/^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u, {
    message: "Expected an SSH destination: a host name or address, optionally prefixed by a user",
  }),
).pipe(Schema.brand("SshDestination"));
export type SshDestination = typeof SshDestination.Type;

/** The TCP port the SSH server of a Worker's machine listens on. */
export const SshPort = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })).pipe(
  Schema.brand("SshPort"),
);
export type SshPort = typeof SshPort.Type;

/**
 * The private key file the local `ssh` client authenticates with, absolute
 * or relative to the orchestrator user's home (`~/.ssh/usine_worker`).
 */
export const SshIdentityFile = Schema.String.check(
  Schema.isPattern(/^(?:\/|~\/)[!-~]+$/u, {
    message: "Expected an absolute or ~/ key path without spaces or control characters",
  }),
).pipe(Schema.brand("SshIdentityFile"));
export type SshIdentityFile = typeof SshIdentityFile.Type;

/**
 * The absolute directory on a Worker's machine under which every Worker using
 * it keeps its cached clones, Attempt checkouts, and Attempt credentials, at
 * `<root>/workers/<worker>`. Printable characters only, no trailing slash.
 */
export const WorkerRoot = Schema.String.check(
  Schema.isPattern(/^(?:\/[!-.0-~]+)+$/u, {
    message: "Expected an absolute directory without spaces, control characters, or a trailing /",
  }),
).pipe(Schema.brand("WorkerRoot"));
export type WorkerRoot = typeof WorkerRoot.Type;

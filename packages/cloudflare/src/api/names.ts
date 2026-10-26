// Imports Schema alone, not the whole `effect` index: the executor's sandbox shell loads this
// module once per command, through `stream.ts`.
import * as Schema from "effect/Schema";

/**
 * The request headers with the Cloudflare Access service token. The Worker refuses every request
 * whose headers don't match the token it's configured with.
 */
export const ACCESS_CLIENT_ID_HEADER = "cf-access-client-id";
export const ACCESS_CLIENT_SECRET_HEADER = "cf-access-client-secret";

/**
 * The usine instance and Worker that a sandbox belongs to: the instance's identity, such as
 * `github-app-123`, a dot, and the usine Worker's name. Orphan cleanup lists only its own owner's
 * sandboxes, so instances that share a deployed Worker never remove each other's.
 */
export const SandboxOwner = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/u, {
    message: "Expected a sandbox owner: <instance>.<worker>, each in kebab case",
  }),
).pipe(Schema.brand("SandboxOwner"));
export type SandboxOwner = typeof SandboxOwner.Type;

/** A sandbox's Durable Object name: its owner, a dot, and the Attempt as a path segment. */
export const SandboxName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*\.[A-Za-z0-9_.-]{1,160}$/u, {
    message: "Expected a sandbox name: <instance>.<worker>.<attempt>",
  }),
).pipe(Schema.brand("SandboxName"));
export type SandboxName = typeof SandboxName.Type;

/** The ID of one command a sandbox ran through its exec stream, which names its process files. */
export const ProcessId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{32}$/u, { message: "Expected 32 lowercase hexadecimal digits" }),
).pipe(Schema.brand("ProcessId"));
export type ProcessId = typeof ProcessId.Type;

/** Returns the path of the WebSocket that runs one command in the sandbox (`stream.ts`). */
export const execPath = (name: SandboxName): string => `/v1/sandboxes/${name}/exec`;

/**
 * Returns the path of the WebSocket that streams a command's output from the given byte offsets
 * of its process files, then its exit code.
 */
export const attachPath = (name: SandboxName, process: ProcessId): string =>
  `/v1/sandboxes/${name}/processes/${process}/attach`;

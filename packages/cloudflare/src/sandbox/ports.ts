import { AttemptId } from "@usine/core/attempt";
import { CloudflareImageName, CloudflareInstanceType } from "@usine/core/worker";
import { Context, type DateTime, type Duration, Effect, type Option, Schema } from "effect";
import { SandboxCredentials, SandboxName, SandboxOwner, SandboxSummary } from "../api/api.ts";
import type { Interception } from "./outbound.ts";

/** A command started in the container, with the streams the start requested. */
export interface ContainerProcess {
  readonly stdin: WritableStream<Uint8Array> | null;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly exitCode: Promise<number>;
}

export const ContainerOperation = Schema.Literals([
  "start",
  "exec",
  "read",
  "destroy",
  "keep-alive",
  "intercept",
]);
export type ContainerOperation = typeof ContainerOperation.Type;

/** A Container API call failed. `message` comes from the runtime and contains no credential. */
export class ContainerFailure extends Schema.TaggedError<ContainerFailure>()("ContainerFailure", {
  operation: ContainerOperation,
  message: Schema.String,
}) {}

/** The Durable Object Container API calls a sandbox makes (`ctx.container` in the Worker). */
export class SandboxContainer extends Context.Service<
  SandboxContainer,
  {
    readonly running: Effect.Effect<boolean>;
    /** The Worker's `containers[].images`, by name. */
    readonly images: Effect.Effect<Readonly<Record<string, string>>>;
    /** Starts the container from `image`, an entry of `images`, without internet access. */
    readonly start: (
      image: string,
      instanceType: CloudflareInstanceType,
    ) => Effect.Effect<void, ContainerFailure>;
    /** Runs `command` as the image's user in its home directory, with piped stdout and stderr. */
    readonly exec: (
      command: ReadonlyArray<string>,
      stdin: "pipe" | "closed",
    ) => Effect.Effect<ContainerProcess, ContainerFailure>;
    /** Returns the content of `path`, or `None` if it doesn't exist. */
    readonly read: (path: string) => Effect.Effect<Option.Option<Uint8Array>, ContainerFailure>;
    /** Returns the content of `path` after its first `offset` bytes, or `None` if it doesn't exist. */
    readonly readFrom: (
      path: string,
      offset: number,
    ) => Effect.Effect<Option.Option<Uint8Array>, ContainerFailure>;
    /** Returns the size of `path` in bytes, or `None` if it doesn't exist. */
    readonly size: (path: string) => Effect.Effect<Option.Option<number>, ContainerFailure>;
    readonly destroy: Effect.Effect<void, ContainerFailure>;
    /** Sets the time without a request after which the platform stops the container. */
    readonly keepAlive: (inactivity: Duration.Duration) => Effect.Effect<void, ContainerFailure>;
    /** Sends the container's requests for the interception's host to its outbound handler. */
    readonly intercept: (interception: Interception) => Effect.Effect<void, ContainerFailure>;
  }
>()("@usine/cloudflare/SandboxContainer") {}

/** A sandbox as its Durable Object stores it. */
export class StoredSandbox extends Schema.Class<StoredSandbox>("@usine/cloudflare/StoredSandbox")({
  name: SandboxName,
  owner: SandboxOwner,
  attempt: AttemptId,
  image: CloudflareImageName,
  instanceType: CloudflareInstanceType,
  createdAt: Schema.DateTimeUtc,
  /**
   * The keepalive alarm keeps the container running until this time. Each create, credential
   * renewal, and command extends it.
   */
  leaseUntil: Schema.DateTimeUtc,
  /**
   * Whether usine holds the sandbox for a checkout that it keeps. The keepalive alarm then keeps
   * the container running past `leaseUntil`, until usine destroys the sandbox.
   */
  held: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  /** Kept so the outbound handlers can be registered again after the Durable Object restarts. */
  credentials: SandboxCredentials,
}) {
  summary(running: boolean, draining: boolean): SandboxSummary {
    return new SandboxSummary({
      name: this.name,
      owner: this.owner,
      attempt: this.attempt,
      image: this.image,
      instanceType: this.instanceType,
      createdAt: this.createdAt,
      running,
      held: this.held,
      draining,
    });
  }
}

/** The Durable Object storage of one sandbox. */
export class SandboxStorage extends Context.Service<
  SandboxStorage,
  {
    readonly load: Effect.Effect<Option.Option<StoredSandbox>>;
    readonly save: (sandbox: StoredSandbox) => Effect.Effect<void>;
    /** Deletes the stored sandbox and its alarm. */
    readonly clear: Effect.Effect<void>;
    /** Replaces the sandbox's alarm. */
    readonly alarmAt: (at: DateTime.Utc) => Effect.Effect<void>;
  }
>()("@usine/cloudflare/SandboxStorage") {}

/** The registry that lists the sandboxes of each usine Worker. */
export class SandboxDirectory extends Context.Service<
  SandboxDirectory,
  {
    readonly record: (sandbox: SandboxSummary) => Effect.Effect<void>;
    readonly forget: (name: SandboxName) => Effect.Effect<void>;
  }
>()("@usine/cloudflare/SandboxDirectory") {}

/** The Worker's settings that every sandbox reads. */
export class SandboxSettings extends Context.Service<
  SandboxSettings,
  {
    /** The hosts the sandboxes reach over HTTPS without a credential, from `ALLOWED_HOSTS`. */
    readonly allowedHosts: ReadonlyArray<string>;
  }
>()("@usine/cloudflare/SandboxSettings") {}

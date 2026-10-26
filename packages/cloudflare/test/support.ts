import { AttemptId } from "@usine/core/attempt";
import { CloudflareImageName } from "@usine/core/worker";
import { DateTime, Effect, Layer, Option, Redacted } from "effect";
import {
  ApiKeyCredential,
  ProviderGrant,
  SandboxCredentials,
  SandboxName,
  SandboxOwner,
  type SandboxSummary,
} from "../src/api/api.ts";
import type { Interception } from "../src/sandbox/outbound.ts";
import {
  type ContainerProcess,
  SandboxContainer,
  SandboxDirectory,
  SandboxSettings,
  SandboxStorage,
  StoredSandbox,
} from "../src/sandbox/ports.ts";

export const NAME = SandboxName.make("github-app-1.cf-one.run-1_execute_1");
export const OWNER = SandboxOwner.make("github-app-1.cf-one");
export const ATTEMPT = AttemptId.make("run-1/execute/1");
export const IMAGE = CloudflareImageName.make("usine");

/** When usine issued the credentials of `storedSandbox`. */
export const ISSUED_AT = "2026-10-26T08:00:00.000Z";

const credentials = (token = "ghs_first") =>
  new SandboxCredentials({
    issuedAt: DateTime.makeUnsafe(ISSUED_AT),
    github: Option.some(Redacted.make(token)),
    providers: [
      new ProviderGrant({
        provider: "anthropic",
        credential: new ApiKeyCredential({ key: Redacted.make("sk-ant-key") }),
      }),
    ],
  });

export const storedSandbox = (leaseUntil: DateTime.Utc, held = false) =>
  new StoredSandbox({
    name: NAME,
    owner: OWNER,
    attempt: ATTEMPT,
    image: IMAGE,
    instanceType: "standard-4",
    createdAt: DateTime.makeUnsafe(0),
    leaseUntil,
    held,
    credentials: credentials(),
  });

const encoder = new TextEncoder();

/** Returns a running process whose output and exit the test controls. */
export const controlledProcess = () => {
  const out = new TransformStream<Uint8Array, Uint8Array>();
  const err = new TransformStream<Uint8Array, Uint8Array>();
  const received: Array<Uint8Array> = [];
  let stdinClosed = false;
  let resolveExit: (code: number) => void = () => undefined;
  const exitCode = new Promise<number>((resolve) => (resolveExit = resolve));
  const stdin = new WritableStream<Uint8Array>({
    write: (chunk) => {
      received.push(chunk);
    },
    close: () => {
      stdinClosed = true;
    },
  });
  const outWriter = out.writable.getWriter();
  const errWriter = err.writable.getWriter();
  return {
    process: {
      stdin,
      stdout: out.readable,
      stderr: err.readable,
      exitCode,
    } satisfies ContainerProcess,
    received,
    stdinClosed: () => stdinClosed,
    stdout: (text: string) => outWriter.write(encoder.encode(text)),
    stderr: (text: string) => errWriter.write(encoder.encode(text)),
    exit: async (code: number) => {
      await outWriter.close();
      await errWriter.close();
      resolveExit(code);
    },
  };
};

/** Returns a process that has already written `stdout` and exited with `exitCode`. */
export const finishedProcess = (stdout: string, exitCode = 0): ContainerProcess => ({
  stdin: null,
  stdout: new Response(stdout).body,
  stderr: new Response("").body,
  exitCode: Promise.resolve(exitCode),
});

interface FakeSandboxState {
  running: boolean;
  readonly images: Record<string, string>;
  readonly started: Array<{ readonly image: string; readonly instanceType: string }>;
  readonly interceptions: Array<Interception>;
  readonly execs: Array<ReadonlyArray<string>>;
  /** The files in the container, by path. */
  readonly files: Map<string, Uint8Array>;
  destroyed: number;
  keepAlives: number;
  stored: Option.Option<StoredSandbox>;
  alarm: Option.Option<DateTime.Utc>;
  readonly recorded: Array<SandboxSummary>;
  readonly forgotten: Array<SandboxName>;
  /** Returns the process for a command; the default prints nothing and exits 0. */
  run: (command: ReadonlyArray<string>) => ContainerProcess;
  /** Runs before the container reads a file; the default returns at once. */
  beforeRead: (path: string) => Effect.Effect<void>;
  /** Runs before the container registers an outbound handler; the default returns at once. */
  beforeIntercept: () => Effect.Effect<void>;
}

export const fakeSandbox = (allowedHosts: ReadonlyArray<string> = ["registry.npmjs.org"]) => {
  const state: FakeSandboxState = {
    running: false,
    images: { usine: "registry.cloudflare.com/acme/usine@sha256:abc" },
    started: [],
    interceptions: [],
    execs: [],
    files: new Map(),
    destroyed: 0,
    keepAlives: 0,
    stored: Option.none(),
    alarm: Option.none(),
    recorded: [],
    forgotten: [],
    run: () => finishedProcess(""),
    beforeRead: () => Effect.void,
    beforeIntercept: () => Effect.void,
  };
  const layer = Layer.mergeAll(
    Layer.succeed(SandboxContainer)({
      running: Effect.sync(() => state.running),
      images: Effect.sync(() => state.images),
      start: (image, instanceType) =>
        Effect.sync(() => {
          state.started.push({ image, instanceType });
          state.running = true;
        }),
      exec: (command) =>
        Effect.sync(() => {
          state.execs.push(command);
          return state.run(command);
        }),
      read: (path) =>
        state
          .beforeRead(path)
          .pipe(Effect.andThen(Effect.sync(() => Option.fromNullishOr(state.files.get(path))))),
      readFrom: (path, offset) =>
        Effect.sync(() =>
          Option.map(Option.fromNullishOr(state.files.get(path)), (bytes) =>
            bytes.subarray(offset),
          ),
        ),
      size: (path) =>
        Effect.sync(() =>
          Option.map(Option.fromNullishOr(state.files.get(path)), ({ length }) => length),
        ),
      destroy: Effect.sync(() => {
        state.destroyed += 1;
        state.running = false;
      }),
      keepAlive: () =>
        Effect.sync(() => {
          state.keepAlives += 1;
        }),
      intercept: (interception) =>
        state.beforeIntercept().pipe(
          Effect.andThen(
            Effect.sync(() => {
              state.interceptions.push(interception);
            }),
          ),
        ),
    }),
    Layer.succeed(SandboxStorage)({
      load: Effect.sync(() => state.stored),
      modify: (change) =>
        Effect.sync(() => {
          const [result, changed] = change(state.stored);
          if (Option.isSome(changed)) state.stored = changed;
          return result;
        }),
      clear: Effect.sync(() => {
        state.stored = Option.none();
        state.alarm = Option.none();
      }),
      alarmAt: (at) =>
        Effect.sync(() => {
          state.alarm = Option.some(at);
        }),
    }),
    Layer.succeed(SandboxDirectory)({
      record: (sandbox) => Effect.sync(() => void state.recorded.push(sandbox)),
      forget: (name) => Effect.sync(() => void state.forgotten.push(name)),
    }),
    Layer.succeed(SandboxSettings)({ allowedHosts }),
  );
  return { state, layer };
};

export const text = (value: string) => encoder.encode(value);

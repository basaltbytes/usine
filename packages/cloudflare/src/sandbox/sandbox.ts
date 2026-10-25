import { CloudflareImageName } from "@usine/core/worker";
import { DateTime, Duration, Effect, Layer, Option, Schema } from "effect";
import { HttpServer } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import {
  ContainerUnavailable,
  type CreateSandbox,
  Destroyed,
  HealthReport,
  healthGroup,
  ImageNotFound,
  type ProcessId,
  ProcessExited,
  ProcessNotFound,
  ProcessRunning,
  ProcessStatus,
  SANDBOX_PROTOCOL,
  type SandboxCredentials,
  SandboxConflict,
  sandboxGroup,
  type SandboxName,
  SandboxNotFound,
  Stopped,
} from "../api/api.ts";
import { interceptionsFor } from "./outbound.ts";
import {
  ContainerFailure,
  type ContainerProcess,
  SandboxContainer,
  SandboxDirectory,
  SandboxSettings,
  SandboxStorage,
  StoredSandbox,
} from "./ports.ts";
import { exitCodeOf, pidOf, processFiles, stopCommand, stoppedCount } from "./process.ts";

/** How long the keepalive alarm keeps a container running after the last create, renewal, or command. */
export const LEASE = Duration.hours(2);
/** The interval of the keepalive alarm. */
const KEEPALIVE_INTERVAL = Duration.minutes(4);
/** The time without a request after which the platform stops the container. */
const INACTIVITY_TIMEOUT = Duration.minutes(10);

const decoder = new TextDecoder();

const unavailable = (name: SandboxName) => (failure: ContainerFailure) =>
  new ContainerUnavailable({ name, message: `${failure.operation}: ${failure.message}` });

/** Returns the bytes of `stream`, or none if it's `null`. */
const readAll = async (stream: ReadableStream<Uint8Array> | null): Promise<Uint8Array> =>
  stream === null ? new Uint8Array() : new Uint8Array(await new Response(stream).arrayBuffer());

/** Waits for `process` to exit and returns its output and exit code. */
export const collect = (process: ContainerProcess) =>
  Effect.tryPromise({
    try: () => Promise.all([readAll(process.stdout), readAll(process.stderr), process.exitCode]),
    catch: (cause) =>
      new ContainerFailure({
        operation: "exec",
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  }).pipe(
    Effect.map(([stdout, stderr, exitCode]) => ({
      stdout: decoder.decode(stdout),
      stderr: decoder.decode(stderr),
      exitCode,
    })),
  );

/** Returns the stored sandbox, or fails with `SandboxNotFound`. */
const stored = Effect.fn("Sandbox.stored")(function* (name: SandboxName) {
  const storage = yield* SandboxStorage;
  const found = yield* storage.load;
  if (Option.isNone(found)) return yield* new SandboxNotFound({ name });
  return found.value;
});

/** Returns the stored sandbox if its container runs, or fails with `ContainerUnavailable`. */
export const runningSandboxFor = Effect.fn("Sandbox.running")(function* (name: SandboxName) {
  const sandbox = yield* stored(name);
  const container = yield* SandboxContainer;
  if (!(yield* container.running))
    return yield* new ContainerUnavailable({
      name,
      message: "The container isn't running, so its disk is gone",
    });
  return sandbox;
});

/** Sends the container's traffic for GitHub, the providers, and the allowlisted hosts to the outbound handlers. */
const intercept = Effect.fn("Sandbox.intercept")(function* (
  name: SandboxName,
  credentials: SandboxCredentials,
) {
  const container = yield* SandboxContainer;
  const { allowedHosts } = yield* SandboxSettings;
  const interceptions = interceptionsFor(credentials, allowedHosts);
  yield* Effect.forEach(interceptions, container.intercept, { discard: true });
  yield* Effect.logInfo("Registered the sandbox's outbound handlers", {
    sandbox: name,
    hosts: interceptions.map(({ _tag, host }) => `${_tag}:${host}`).join(","),
  });
});

/** Returns `sandbox` with its lease extended from now, and saves it. */
export const extendLease = Effect.fn("Sandbox.extendLease")(function* (
  sandbox: StoredSandbox,
  credentials: SandboxCredentials = sandbox.credentials,
) {
  const storage = yield* SandboxStorage;
  const now = yield* DateTime.now;
  const extended = new StoredSandbox({
    name: sandbox.name,
    owner: sandbox.owner,
    attempt: sandbox.attempt,
    image: sandbox.image,
    instanceType: sandbox.instanceType,
    createdAt: sandbox.createdAt,
    leaseUntil: DateTime.addDuration(now, LEASE),
    credentials,
  });
  yield* storage.save(extended);
  return extended;
});

const create = Effect.fn("Sandbox.create")(function* (name: SandboxName, request: CreateSandbox) {
  const fields = {
    sandbox: name,
    owner: request.owner,
    attempt: request.attempt,
    image: request.image,
    instanceType: request.instanceType,
  };
  yield* Effect.annotateCurrentSpan(fields);
  const container = yield* SandboxContainer;
  const storage = yield* SandboxStorage;
  const directory = yield* SandboxDirectory;
  const existing = yield* storage.load;
  if (
    Option.isSome(existing) &&
    (existing.value.owner !== request.owner || existing.value.attempt !== request.attempt)
  ) {
    yield* Effect.logWarning("Refused a sandbox that exists for another Attempt", {
      ...fields,
      existingOwner: existing.value.owner,
      existingAttempt: existing.value.attempt,
    });
    return yield* new SandboxConflict({
      name,
      owner: existing.value.owner,
      attempt: existing.value.attempt,
    });
  }
  const images = yield* container.images;
  const image = images[request.image];
  if (image === undefined) {
    yield* Effect.logWarning("Refused a sandbox for an image the Worker doesn't have", {
      ...fields,
      images: Object.keys(images).join(","),
    });
    return yield* new ImageNotFound({ image: request.image, images: Object.keys(images) });
  }
  const now = yield* DateTime.now;
  const wasRunning = yield* container.running;
  if (!wasRunning)
    yield* container.start(image, request.instanceType).pipe(Effect.mapError(unavailable(name)));
  yield* container.keepAlive(INACTIVITY_TIMEOUT).pipe(Effect.mapError(unavailable(name)));
  yield* intercept(name, request.credentials).pipe(Effect.mapError(unavailable(name)));
  const sandbox = new StoredSandbox({
    name,
    owner: request.owner,
    attempt: request.attempt,
    image: request.image,
    instanceType: request.instanceType,
    createdAt: Option.match(existing, { onNone: () => now, onSome: ({ createdAt }) => createdAt }),
    leaseUntil: DateTime.addDuration(now, LEASE),
    credentials: request.credentials,
  });
  yield* storage.save(sandbox);
  yield* storage.alarmAt(DateTime.addDuration(now, KEEPALIVE_INTERVAL));
  const summary = sandbox.summary(true);
  yield* directory.record(summary);
  yield* Effect.logInfo(
    Option.isNone(existing)
      ? "Created the Attempt's sandbox"
      : wasRunning
        ? "The Attempt's sandbox already runs; renewed its credentials"
        : "Restarted the Attempt's sandbox, whose container had stopped",
    fields,
  );
  return summary;
});

const get = Effect.fn("Sandbox.get")(function* (name: SandboxName) {
  yield* Effect.annotateCurrentSpan({ sandbox: name });
  const sandbox = yield* stored(name);
  const container = yield* SandboxContainer;
  return sandbox.summary(yield* container.running);
});

const credentials = Effect.fn("Sandbox.credentials")(function* (
  name: SandboxName,
  renewed: SandboxCredentials,
) {
  yield* Effect.annotateCurrentSpan({ sandbox: name });
  const sandbox = yield* runningSandboxFor(name);
  yield* intercept(name, renewed).pipe(Effect.mapError(unavailable(name)));
  const extended = yield* extendLease(sandbox, renewed);
  yield* Effect.logInfo("Renewed the sandbox's credentials", {
    sandbox: name,
    attempt: sandbox.attempt,
    leaseUntil: DateTime.formatIso(extended.leaseUntil),
  });
  return extended.summary(true);
});

const stop = Effect.fn("Sandbox.stop")(function* (name: SandboxName) {
  yield* Effect.annotateCurrentSpan({ sandbox: name });
  const sandbox = yield* stored(name);
  const container = yield* SandboxContainer;
  if (!(yield* container.running)) {
    yield* Effect.logInfo("The sandbox's container isn't running; no command to stop", {
      sandbox: name,
    });
    return new Stopped({ stopped: 0 });
  }
  const process = yield* container
    .exec(stopCommand, "closed")
    .pipe(Effect.mapError(unavailable(name)));
  const result = yield* collect(process).pipe(Effect.mapError(unavailable(name)));
  const count = stoppedCount(result.stdout);
  if (result.exitCode !== 0 || Option.isNone(count))
    return yield* new ContainerUnavailable({
      name,
      message: `The stop script exited with code ${String(result.exitCode)}: ${result.stderr.trim()}`,
    });
  yield* Effect.logInfo("Stopped the sandbox's commands", {
    sandbox: name,
    attempt: sandbox.attempt,
    stopped: count.value,
  });
  return new Stopped({ stopped: count.value });
});

const destroy = Effect.fn("Sandbox.destroy")(function* (name: SandboxName) {
  yield* Effect.annotateCurrentSpan({ sandbox: name });
  const container = yield* SandboxContainer;
  const storage = yield* SandboxStorage;
  const directory = yield* SandboxDirectory;
  const existing = yield* storage.load;
  if (yield* container.running) yield* container.destroy.pipe(Effect.mapError(unavailable(name)));
  yield* storage.clear;
  yield* directory.forget(name);
  yield* Effect.logInfo(
    Option.isSome(existing) ? "Destroyed the sandbox" : "No sandbox to destroy",
    {
      sandbox: name,
      attempt: Option.getOrUndefined(Option.map(existing, ({ attempt }) => attempt)),
    },
  );
  return new Destroyed({ destroyed: Option.isSome(existing) });
});

const processStatus = Effect.fn("Sandbox.process")(function* (
  name: SandboxName,
  process: ProcessId,
) {
  yield* Effect.annotateCurrentSpan({ sandbox: name, process });
  yield* runningSandboxFor(name);
  const container = yield* SandboxContainer;
  const files = processFiles(process);
  const read = (path: string) =>
    container
      .read(path)
      .pipe(
        Effect.mapError(unavailable(name)),
        Effect.map(Option.map((bytes) => decoder.decode(bytes))),
      );
  const pid = Option.flatMap(yield* read(files.pid), pidOf);
  if (Option.isNone(pid)) return yield* new ProcessNotFound({ name, process });
  const exitCode = Option.flatMap(yield* read(files.exit), exitCodeOf);
  const size = (path: string) =>
    container
      .size(path)
      .pipe(Effect.mapError(unavailable(name)), Effect.map(Option.getOrElse(() => 0)));
  return new ProcessStatus({
    process,
    pid: pid.value,
    state: Option.match(exitCode, {
      onNone: () => new ProcessRunning(),
      onSome: (code) => new ProcessExited({ exitCode: code }),
    }),
    stdoutBytes: yield* size(files.stdout),
    stderrBytes: yield* size(files.stderr),
  });
});

const isImageName = Schema.is(CloudflareImageName);

const health = Effect.fn("Sandbox.health")(function* () {
  const container = yield* SandboxContainer;
  const images = Object.keys(yield* container.images).filter(isImageName);
  return new HealthReport({ protocol: SANDBOX_PROTOCOL, images });
});

/**
 * Keeps the container running while the sandbox's lease lasts, then lets the platform stop it
 * after `INACTIVITY_TIMEOUT`. Runs from the Durable Object's alarm, and sets the next one.
 */
export const keepAlive = Effect.fn("Sandbox.keepAlive")(function* () {
  const storage = yield* SandboxStorage;
  const container = yield* SandboxContainer;
  const found = yield* storage.load;
  if (Option.isNone(found)) {
    yield* Effect.logDebug("The keepalive alarm found no sandbox; it isn't set again");
    return;
  }
  const sandbox = found.value;
  const fields = { sandbox: sandbox.name, attempt: sandbox.attempt };
  const now = yield* DateTime.now;
  if (DateTime.isGreaterThan(now, sandbox.leaseUntil)) {
    yield* Effect.logWarning(
      "The sandbox's lease expired without a request from usine; the platform stops its container after the inactivity timeout",
      { ...fields, leaseUntil: DateTime.formatIso(sandbox.leaseUntil) },
    );
    return;
  }
  if (!(yield* container.running)) {
    yield* Effect.logInfo("The sandbox's container stopped; the keepalive alarm ends", fields);
    return;
  }
  yield* container.keepAlive(INACTIVITY_TIMEOUT).pipe(
    Effect.tapError((failure) =>
      Effect.logWarning("Could not renew the container's inactivity timeout", {
        ...fields,
        operation: failure.operation,
        message: failure.message,
      }),
    ),
    Effect.ignore,
  );
  yield* storage.alarmAt(DateTime.addDuration(now, KEEPALIVE_INTERVAL));
});

/**
 * Registers the outbound handlers again after the Durable Object restarts while its container
 * runs. Does nothing for a sandbox without a running container.
 */
export const restore = Effect.fn("Sandbox.restore")(function* () {
  const storage = yield* SandboxStorage;
  const container = yield* SandboxContainer;
  const found = yield* storage.load;
  if (Option.isNone(found) || !(yield* container.running)) return;
  yield* intercept(found.value.name, found.value.credentials).pipe(
    Effect.tapError((failure) =>
      Effect.logError("Could not register the sandbox's outbound handlers again", {
        sandbox: found.value.name,
        operation: failure.operation,
        message: failure.message,
      }),
    ),
    Effect.ignore,
  );
});

const SandboxServedApi = HttpApi.make("SandboxApi").add(healthGroup, sandboxGroup);

const healthHandlers = HttpApiBuilder.group(SandboxServedApi, "health", (routes) =>
  routes.handle("health", () => health()),
);

const sandboxHandlers = HttpApiBuilder.group(SandboxServedApi, "sandbox", (routes) =>
  routes
    .handle("create", ({ params, payload }) => create(params.name, payload))
    .handle("get", ({ params }) => get(params.name))
    .handle("credentials", ({ params, payload }) => credentials(params.name, payload))
    .handle("stop", ({ params }) => stop(params.name))
    .handle("destroy", ({ params }) => destroy(params.name))
    .handle("process", ({ params }) => processStatus(params.name, params.process)),
);

/**
 * The health and sandbox routes of `SandboxApi`, served by each sandbox's Durable Object. Requires
 * `SandboxContainer`, `SandboxStorage`, `SandboxDirectory`, and `SandboxSettings`.
 */
export const sandboxRoutes = HttpApiBuilder.layer(SandboxServedApi).pipe(
  Layer.provide([healthHandlers, sandboxHandlers]),
  Layer.provide(HttpServer.layerServices),
);

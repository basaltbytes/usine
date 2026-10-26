import { CloudflareImageName } from "@usine/core/worker";
import { DateTime, Duration, Effect, Layer, Option, Schema, Semaphore } from "effect";
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
  StaleCredentials,
  Stopped,
} from "../api/api.ts";
import { DRAIN_MARKER } from "../api/harness.ts";
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

/** Waits for `process` to exit and returns its output bytes, unchanged, and exit code. */
export const collectBytes = (process: ContainerProcess) =>
  Effect.tryPromise({
    try: () => Promise.all([readAll(process.stdout), readAll(process.stderr), process.exitCode]),
    catch: (cause) =>
      new ContainerFailure({
        operation: "exec",
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  }).pipe(Effect.map(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode })));

/** Waits for `process` to exit and returns its output as UTF-8 text, and exit code. */
const collect = (process: ContainerProcess) =>
  collectBytes(process).pipe(
    Effect.map(({ stdout, stderr, exitCode }) => ({
      stdout: decoder.decode(stdout),
      stderr: decoder.decode(stderr),
      exitCode,
    })),
  );

/**
 * Returns `sandbox`'s summary as its container is now. A drain marker that can't be read is
 * logged and reported as no drain; the executor asks again.
 */
const summarize = Effect.fn("Sandbox.summarize")(function* (sandbox: StoredSandbox) {
  const container = yield* SandboxContainer;
  const running = yield* container.running;
  if (!running) return sandbox.summary(false, false);
  const draining = yield* container.size(DRAIN_MARKER).pipe(
    Effect.map(Option.isSome),
    Effect.tapError((failure) =>
      Effect.logWarning("Could not read the sandbox's drain marker", {
        sandbox: sandbox.name,
        operation: failure.operation,
        message: failure.message,
      }),
    ),
    Effect.orElseSucceed(() => false),
  );
  if (draining)
    yield* Effect.logWarning(
      "The platform is stopping the sandbox's container, which loses its disk",
      { sandbox: sandbox.name, attempt: sandbox.attempt },
    );
  return sandbox.summary(true, draining);
});

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

/** Fails with `StaleCredentials` if `sandbox` holds credentials issued after `credentials`. */
const refuseStale = Effect.fn("Sandbox.refuseStale")(function* (
  sandbox: StoredSandbox,
  credentials: SandboxCredentials,
) {
  const current = sandbox.credentials.issuedAt;
  if (!DateTime.isLessThan(credentials.issuedAt, current)) return;
  yield* Effect.logWarning("Refused credentials issued before the ones the sandbox holds", {
    sandbox: sandbox.name,
    attempt: sandbox.attempt,
    issuedAt: DateTime.formatIso(credentials.issuedAt),
    current: DateTime.formatIso(current),
  });
  return yield* new StaleCredentials({
    name: sandbox.name,
    issuedAt: credentials.issuedAt,
    current,
  });
});

/**
 * Applies `change` to the sandbox as it's stored now, saves the result, and returns it, or fails
 * with `SandboxNotFound` if the sandbox was destroyed.
 */
const updateStored = Effect.fn("Sandbox.updateStored")(function* (
  name: SandboxName,
  change: (sandbox: StoredSandbox) => StoredSandbox,
) {
  const storage = yield* SandboxStorage;
  const updated = yield* storage.modify((stored) => {
    const changed = Option.map(stored, change);
    return [changed, changed] as const;
  });
  if (Option.isNone(updated)) return yield* new SandboxNotFound({ name });
  return updated.value;
});

/**
 * Extends the sandbox's lease from now and returns the stored sandbox, or fails with
 * `SandboxNotFound` if it was destroyed.
 */
export const extendLease = Effect.fn("Sandbox.extendLease")(function* (name: SandboxName) {
  const now = yield* DateTime.now;
  return yield* updateStored(
    name,
    (sandbox) => new StoredSandbox({ ...sandbox, leaseUntil: DateTime.addDuration(now, LEASE) }),
  );
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
  if (Option.isSome(existing)) yield* refuseStale(existing.value, request.credentials);
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
  // Reads the stored sandbox again: a hold may have arrived while the container started.
  const sandbox = yield* storage.modify((current) => {
    const created = new StoredSandbox({
      name,
      owner: request.owner,
      attempt: request.attempt,
      image: request.image,
      instanceType: request.instanceType,
      createdAt: Option.match(current, { onNone: () => now, onSome: ({ createdAt }) => createdAt }),
      leaseUntil: DateTime.addDuration(now, LEASE),
      // A hold lasts until the sandbox is destroyed, through a reattachment.
      held: Option.exists(current, ({ held }) => held),
      credentials: request.credentials,
    });
    return [created, Option.some(created)] as const;
  });
  yield* storage.alarmAt(DateTime.addDuration(now, KEEPALIVE_INTERVAL));
  const summary = yield* summarize(sandbox);
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
  return yield* summarize(yield* stored(name));
});

const credentials = Effect.fn("Sandbox.credentials")(function* (
  name: SandboxName,
  renewed: SandboxCredentials,
) {
  yield* Effect.annotateCurrentSpan({ sandbox: name });
  const sandbox = yield* runningSandboxFor(name);
  yield* refuseStale(sandbox, renewed);
  yield* intercept(name, renewed).pipe(Effect.mapError(unavailable(name)));
  const now = yield* DateTime.now;
  const extended = yield* updateStored(
    name,
    (current) =>
      new StoredSandbox({
        ...current,
        leaseUntil: DateTime.addDuration(now, LEASE),
        credentials: renewed,
      }),
  );
  yield* Effect.logInfo("Renewed the sandbox's credentials", {
    sandbox: name,
    attempt: sandbox.attempt,
    issuedAt: DateTime.formatIso(renewed.issuedAt),
    github: Option.isSome(renewed.github),
    providers: renewed.providers.map(({ provider }) => provider).join(","),
    leaseUntil: DateTime.formatIso(extended.leaseUntil),
  });
  return yield* summarize(extended);
});

/**
 * Holds the sandbox: the keepalive alarm keeps its container running past the lease, until the
 * sandbox is destroyed. usine holds a sandbox whose checkout it keeps, so that the checkout
 * survives until usine reconciles it.
 */
const hold = Effect.fn("Sandbox.hold")(function* (name: SandboxName) {
  yield* Effect.annotateCurrentSpan({ sandbox: name });
  const sandbox = yield* runningSandboxFor(name);
  const storage = yield* SandboxStorage;
  const now = yield* DateTime.now;
  const held = yield* updateStored(
    name,
    (current) => new StoredSandbox({ ...current, held: true }),
  );
  yield* storage.alarmAt(DateTime.addDuration(now, KEEPALIVE_INTERVAL));
  yield* Effect.logInfo(
    sandbox.held
      ? "The sandbox was already held"
      : "Holding the sandbox until usine reconciles or destroys it",
    { sandbox: name, attempt: sandbox.attempt },
  );
  return yield* summarize(held);
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
  if (result.exitCode !== 0 || Option.isNone(count)) {
    const message = `The stop script exited with code ${String(result.exitCode)}: ${result.stderr.trim()}`;
    yield* Effect.logError("Could not stop the sandbox's commands", {
      sandbox: name,
      attempt: sandbox.attempt,
      message,
    });
    return yield* new ContainerUnavailable({ name, message });
  }
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
 * Keeps the container running while the sandbox's lease lasts or usine holds it, then lets the
 * platform stop it after `INACTIVITY_TIMEOUT`. Runs from the Durable Object's alarm, and sets the
 * next one.
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
  if (!sandbox.held && DateTime.isGreaterThan(now, sandbox.leaseUntil)) {
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
 * Registers the outbound handlers and sets the inactivity timeout again after the Durable Object
 * restarts while its container runs, since the platform resets both for each instance. Does
 * nothing for a sandbox without a running container.
 */
export const restore = Effect.fn("Sandbox.restore")(function* () {
  const storage = yield* SandboxStorage;
  const container = yield* SandboxContainer;
  const found = yield* storage.load;
  if (Option.isNone(found) || !(yield* container.running)) return;
  const fields = { sandbox: found.value.name, attempt: found.value.attempt };
  yield* container.keepAlive(INACTIVITY_TIMEOUT).pipe(
    Effect.tapError((failure) =>
      Effect.logError("Could not set the container's inactivity timeout again", {
        ...fields,
        operation: failure.operation,
        message: failure.message,
      }),
    ),
    Effect.ignore,
  );
  yield* intercept(found.value.name, found.value.credentials).pipe(
    Effect.tapError((failure) =>
      Effect.logError("Could not register the sandbox's outbound handlers again", {
        ...fields,
        operation: failure.operation,
        message: failure.message,
      }),
    ),
    Effect.ignore,
  );
  yield* Effect.logInfo("Restored the running sandbox after its Durable Object restarted", fields);
});

const SandboxServedApi = HttpApi.make("SandboxApi").add(healthGroup, sandboxGroup);

const healthHandlers = HttpApiBuilder.group(SandboxServedApi, "health", (routes) =>
  routes.handle("health", () => health()),
);

const sandboxHandlers = HttpApiBuilder.group(SandboxServedApi, "sandbox", (routes) =>
  Effect.gen(function* () {
    // A create or credential change registers handlers, then stores their credentials. One runs
    // at a time, so another change's handlers never replace them in between.
    const credentialChanges = yield* Semaphore.make(1);
    const oneAtATime = credentialChanges.withPermits(1);
    return routes
      .handle("create", ({ params, payload }) => oneAtATime(create(params.name, payload)))
      .handle("get", ({ params }) => get(params.name))
      .handle("credentials", ({ params, payload }) => oneAtATime(credentials(params.name, payload)))
      .handle("hold", ({ params }) => hold(params.name))
      .handle("stop", ({ params }) => stop(params.name))
      .handle("destroy", ({ params }) => destroy(params.name))
      .handle("process", ({ params }) => processStatus(params.name, params.process));
  }),
);

/**
 * The health and sandbox routes of `SandboxApi`, served by each sandbox's Durable Object. Requires
 * `SandboxContainer`, `SandboxStorage`, `SandboxDirectory`, and `SandboxSettings`.
 */
export const sandboxRoutes = HttpApiBuilder.layer(SandboxServedApi).pipe(
  Layer.provide([healthHandlers, sandboxHandlers]),
  Layer.provide(HttpServer.layerServices),
);

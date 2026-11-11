import {
  Context,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Ref,
  Scope,
} from "effect";
import { HttpClient } from "effect/http";
import { homedir } from "node:os";
import { WorkerCapabilityError } from "../../executor.ts";
import type { BoxdProvisioner } from "../model.ts";
import type { SshWorkerEntry } from "../workers.ts";
import type { ProvisionedMachinesOptions } from "./machines.ts";
import { boxdConnectError, boxdDriverFor, boxdPreflightError, execCredential } from "./boxd.ts";
import { BoxdApi, type BoxdCallError, type BoxdUnknownRegion } from "./boxd/client.ts";
import { BoxdExec, boxdExecLayer } from "./boxd/exec.ts";
import { boxdApiLayer } from "./boxd/grpc-client.ts";
import { BOAT_API, boatDriverFor } from "./boat.ts";
import { HETZNER_API, hetznerDriverFor } from "./hetzner.ts";
import { type MachineDriver, tagValue } from "./model.ts";

type BoxdConnectFailure = BoxdCallError | BoxdUnknownRegion;

/** Returns the absolute path of a key file given as absolute or `~/`. */
const expandHome = (file: string): string =>
  file.startsWith("~/") ? `${homedir()}/${file.slice(2)}` : file;

/** The `get`, `set`, and `delete` of a `Map` or `WeakMap` that holds builds by key. */
interface Builds<K, A, E> {
  readonly get: (key: K) => Deferred.Deferred<A, E> | undefined;
  readonly set: (key: K, build: Deferred.Deferred<A, E>) => void;
  readonly delete: (key: K) => boolean;
}

/**
 * Returns a function that runs a build once per key in `scope` and shares its result. A caller
 * that arrives while the build runs waits for the same result, so concurrent callers fail together
 * when it fails. `builds` keeps a success for later callers and drops a failure, so the next
 * caller builds again. A caller's interruption doesn't interrupt the build.
 */
const sharedBuilds =
  <K, A, E>(scope: Scope.Scope, builds: Builds<K, A, E>) =>
  (key: K, build: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    Effect.suspend(() => {
      const running = builds.get(key);
      if (running !== undefined) return Deferred.await(running);
      const result = Deferred.makeUnsafe<A, E>();
      builds.set(key, result);
      return build.pipe(
        Effect.onExit((exit) =>
          Effect.andThen(
            Effect.sync(() => {
              if (Exit.isFailure(exit)) builds.delete(key);
            }),
            Deferred.done(result, exit),
          ),
        ),
        Effect.forkIn(scope),
        Effect.andThen(Deferred.await(result)),
      );
    });

/** Reuses provider clients for each worker connection; running machines retain their client. */
export const machineDriversFor = Effect.fn("SshExecutor.machineDriversFor")(function* (
  options: Pick<ProvisionedMachinesOptions, "settings" | "instance">,
) {
  const scope = yield* Effect.scope;
  const fs = yield* FileSystem.FileSystem;
  const http = yield* HttpClient.HttpClient;
  const { settings, instance } = options;
  /**
   * The boxd API and `Exec` clients by API key, region, and endpoint, which every revision of a
   * Worker with the same three shares. A failed build closes what it opened.
   */
  const boxdClients = sharedBuilds(
    scope,
    new Map<string, Deferred.Deferred<Context.Context<BoxdApi | BoxdExec>, BoxdConnectFailure>>(),
  );
  const boxdClientsFor = (value: BoxdProvisioner) => {
    const endpoint = settings.providerEndpoints?.boxd;
    return boxdClients(
      // None of the three contains a line break.
      [Redacted.value(value.token), value.region, endpoint ?? ""].join("\n"),
      Effect.gen(function* () {
        const clients = yield* Scope.fork(scope);
        return yield* Effect.gen(function* () {
          const client = yield* Layer.buildWithScope(
            (settings.boxdClient ?? boxdApiLayer)(value.token, value.region, endpoint),
            clients,
          );
          const api = Context.get(client, BoxdApi);
          // One connection to the region carries every command of the Worker's machines.
          const exec = yield* Layer.buildWithScope(
            (settings.boxdExec ?? boxdExecLayer)(api.endpoint, execCredential(value)),
            clients,
          );
          return Context.add(exec, BoxdApi, api);
        }).pipe(Effect.onError((cause) => Scope.close(clients, Exit.failCause(cause))));
      }).pipe(Effect.provideService(HttpClient.HttpClient, http)),
    );
  };
  const readPublicKey = Effect.fn("SshExecutor.readPublicKey")(function* (entry: SshWorkerEntry) {
    const worker = entry.address.name;
    yield* Effect.annotateCurrentSpan({ worker });
    const identity = Option.getOrUndefined(entry.address.identityFile);
    const file = identity === undefined ? undefined : `${expandHome(identity)}.pub`;
    const text =
      file === undefined
        ? Option.none<string>()
        : yield* fs.readFileString(file).pipe(Effect.option);
    const key = Option.filter(
      Option.map(text, (content) => content.trim()),
      (content) => content.length > 0,
    );
    if (Option.isSome(key)) return key.value;
    return yield* WorkerCapabilityError.make({
      worker,
      capability: "credentials",
      message: `Provisioned worker "${worker}" needs the public key of identity_file at ${file ?? "<identity_file>.pub"}, which it adds to each Boat sandbox`,
      cause: new Error(`no public key at ${file ?? "identity_file"}`),
    });
  });

  const buildDriver = Effect.fn("SshExecutor.machineDriver")(function* (entry: SshWorkerEntry) {
    const worker = entry.address.name;
    yield* Effect.annotateCurrentSpan({ worker });
    const provisioner =
      entry.address.machine._tag === "Provisioned"
        ? Option.some(entry.address.machine.provisioner)
        : Option.none();
    if (Option.isNone(provisioner))
      return yield* WorkerCapabilityError.make({
        worker,
        capability: "machine",
        message: `SSH worker "${worker}" has a machine of its own and creates none`,
        cause: new Error("long-lived SSH worker"),
      });
    const value = provisioner.value;
    switch (value.provider) {
      case "hetzner":
        return yield* hetznerDriverFor(
          worker,
          value,
          Option.isSome(entry.gateway),
          settings.providerEndpoints?.hetzner ?? HETZNER_API,
        );
      case "boxd": {
        const clients = yield* boxdClientsFor(value).pipe(
          Effect.tapError((failure) =>
            Effect.logWarning("Could not connect to the boxd region", {
              worker,
              region: value.region,
              ...(failure._tag === "BoxdUnknownRegion"
                ? { failure: "unknown region", available: failure.available }
                : { failure: failure.operation, code: failure.code, message: failure.message }),
            }),
          ),
        );
        return yield* boxdDriverFor(worker, value, entry.address.identityFile).pipe(
          Effect.provide(clients),
        );
      }
      case "boat": {
        const publicKey = yield* readPublicKey(entry);
        return yield* boatDriverFor(
          worker,
          value,
          publicKey,
          settings.providerEndpoints?.boat ?? BOAT_API,
        );
      }
    }
  });
  // A boxd build calls the provider, so only callers for the same entry wait for each other.
  const drivers = sharedBuilds(
    scope,
    new WeakMap<
      SshWorkerEntry,
      Deferred.Deferred<MachineDriver, Effect.Error<ReturnType<typeof buildDriver>>>
    >(),
  );
  const driverOf = (entry: SshWorkerEntry) =>
    drivers(entry, buildDriver(entry).pipe(Effect.provideService(HttpClient.HttpClient, http)));
  /**
   * Returns the driver of `entry` for attempts and cleanup. A boxd region that doesn't answer or
   * rate-limits fails with a `MachineUnavailableError`, which the scheduler retries.
   */
  const forEntry = Effect.fn("SshExecutor.driverForConnection")(function* (entry: SshWorkerEntry) {
    const worker = entry.address.name;
    yield* Effect.annotateCurrentSpan({ worker });
    const connectError = (failure: BoxdConnectFailure) =>
      Effect.fail(boxdConnectError(worker, failure));
    return yield* driverOf(entry).pipe(
      Effect.catchTags({ BoxdCallError: connectError, BoxdUnknownRegion: connectError }),
    );
  });
  /** Returns the driver of `entry` for preflight, which reports every boxd failure as a gap. */
  const forPreflight = Effect.fn("SshExecutor.driverForPreflight")(function* (
    entry: SshWorkerEntry,
  ) {
    const worker = entry.address.name;
    yield* Effect.annotateCurrentSpan({ worker });
    const preflightError = (failure: BoxdConnectFailure) =>
      Effect.fail(boxdPreflightError(worker, failure));
    return yield* driverOf(entry).pipe(
      Effect.catchTags({ BoxdCallError: preflightError, BoxdUnknownRegion: preflightError }),
    );
  });

  const warned = yield* Ref.make(false);
  const warnUnowned = Effect.fn("SshExecutor.warnUnownedMachines")(function* (
    entries: ReadonlyArray<SshWorkerEntry>,
  ) {
    if (yield* Ref.getAndSet(warned, true)) return;
    const reported = new Set<string>();
    yield* Effect.forEach(
      entries,
      (entry) =>
        Effect.gen(function* () {
          const worker = entry.address.name;
          yield* Effect.annotateCurrentSpan({ worker, instance });
          const driver = yield* forEntry(entry);
          const configured = new Set(
            entries
              .filter(
                (entry) =>
                  entry.address.machine._tag === "Provisioned" &&
                  entry.address.machine.provisioner.provider === driver.provider,
              )
              .map((entry) => tagValue(entry.address.name, driver.provider === "boat" ? 24 : 63)),
          );
          for (const machine of yield* driver.list(instance, Option.none())) {
            const key = `${driver.provider}/${machine.id}`;
            if (configured.has(machine.tags.worker) || reported.has(key)) continue;
            reported.add(key);
            yield* Effect.logWarning(
              "Provider lists a machine for this instance with no configured Worker; restore the Worker configuration or delete the machine at the provider",
              {
                instance,
                provider: driver.provider,
                workerTag: machine.tags.worker,
                machine: machine.id,
              },
            );
          }
        }).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("Could not check for machines of unconfigured Workers", {
              worker: entry.address.name,
              instance,
              message: error.message,
            }),
          ),
          Effect.ignore,
        ),
      { discard: true },
    );
  });
  return {
    forEntry,
    forPreflight,
    warnUnowned,
  };
});

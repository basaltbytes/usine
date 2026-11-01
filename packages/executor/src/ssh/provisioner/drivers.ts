import { Effect, FileSystem, Option, Ref, Semaphore } from "effect";
import { HttpClient } from "effect/http";
import { homedir } from "node:os";
import { WorkerCapabilityError } from "../../executor.ts";
import type { SshWorkerEntry } from "../workers.ts";
import type { ProvisionedMachinesOptions } from "./machines.ts";
import { BOAT_API, boatDriverFor } from "./boat.ts";
import { HETZNER_API, hetznerDriverFor } from "./hetzner.ts";
import { type MachineDriver, tagValue } from "./model.ts";

/** Returns the absolute path of a key file given as absolute or `~/`. */
const expandHome = (file: string): string =>
  file.startsWith("~/") ? `${homedir()}/${file.slice(2)}` : file;

/** Reuses provider clients for each worker connection; running machines retain their client. */
export const machineDriversFor = Effect.fn("SshExecutor.machineDriversFor")(function* (
  options: Pick<ProvisionedMachinesOptions, "settings" | "instance">,
) {
  const fs = yield* FileSystem.FileSystem;
  const http = yield* HttpClient.HttpClient;
  const { settings, instance } = options;
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
    return yield* new WorkerCapabilityError({
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
      return yield* new WorkerCapabilityError({
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
      case "boat":
        return yield* boatDriverFor(
          worker,
          value,
          yield* readPublicKey(entry),
          settings.providerEndpoints?.boat ?? BOAT_API,
        );
    }
  });
  const drivers = new WeakMap<SshWorkerEntry, MachineDriver>();
  const exclusive = yield* Semaphore.make(1);
  const forEntry = Effect.fn("SshExecutor.driverForConnection")(function* (entry: SshWorkerEntry) {
    yield* Effect.annotateCurrentSpan({ worker: entry.address.name });
    const existing = drivers.get(entry);
    if (existing !== undefined) return existing;
    const driver = yield* buildDriver(entry).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );
    drivers.set(entry, driver);
    return driver;
  }, exclusive.withPermit);

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
    warnUnowned,
  };
});

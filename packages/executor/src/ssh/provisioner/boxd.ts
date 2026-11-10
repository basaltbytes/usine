import {
  type BoxdEgressAllowlist,
  MachineId,
  SshDestination,
  SshPort,
  type WorkerName,
} from "@usine/core/worker";
import { DateTime, Effect, Option, Schema, Semaphore } from "effect";
import {
  MachineUnavailableError,
  WorkerCapabilityError,
  type MachineUnavailableReason,
} from "../../executor.ts";
import type { BoxdProvisioner } from "../model.ts";
import { BoxdApi, BoxdCallError, type BoxdMachine, type BoxdUnknownRegion } from "./boxd/client.ts";
import {
  attemptTag,
  attemptsFromTag,
  ProviderApiError,
  tagValue,
  type MachineDriver,
  type MachineEndpoint,
  type MachineTags,
} from "./model.ts";

const reasonOf = (code: string): MachineUnavailableReason => {
  switch (code) {
    case "UNAVAILABLE":
    case "DEADLINE_EXCEEDED":
      return "unreachable";
    case "RESOURCE_EXHAUSTED":
      return "quota";
    case "UNAUTHENTICATED":
    case "PERMISSION_DENIED":
    case "INVALID_ARGUMENT":
      return "refused";
    default:
      return "provider";
  }
};

const terminalStates = new Set(["stopped", "failed", "destroyed"]);

/** How long boxd takes to enforce an egress allowlist after `SetVmEgressAllow` returns. */
const EGRESS_IN_FORCE = "1 second";

/** The `BoxdCallError` operation of a failure to apply `provisioner.egress`. */
const EGRESS_OPERATION = "setEgressAllow";

const assignment = (tags: MachineTags) => ({
  "usine.run": tagValue(tags.run),
  "usine.process": tagValue(tags.process),
  "usine.attempt": attemptTag(tags.attempt),
  "usine.attempts": String(tags.attempts),
});

/** Codes for a boxd API that doesn't answer or rate-limits, which a later call can outlast. */
const transientCodes = new Set(["UNAVAILABLE", "DEADLINE_EXCEEDED", "RESOURCE_EXHAUSTED"]);

const transientMessage = (worker: WorkerName, failure: BoxdCallError): string =>
  `boxd didn't answer ${failure.operation} for worker "${worker}": ${failure.code}: ${failure.message}. Check that this host reaches app.boxd.sh, boxd.sh:9443, and the API endpoint of the region, or wait for the boxd rate limit to reset.`;

/** Explains a boxd failure at preflight or while connecting to the region, naming the fix. */
const boxdPreflightError = (
  worker: WorkerName,
  failure: BoxdCallError | BoxdUnknownRegion,
): WorkerCapabilityError => {
  const message =
    failure._tag === "BoxdUnknownRegion"
      ? `boxd has no region "${failure.region}". Set provisioner.region of worker "${worker}" to one of the regions boxd lists: ${failure.available.join(", ") || "none"}.`
      : failure.code === "UNAUTHENTICATED" || failure.code === "PERMISSION_DENIED"
        ? `boxd refused the API key of worker "${worker}". Create one with boxd auth keys create usine --kind member and set provisioner.token_env.`
        : transientCodes.has(failure.code)
          ? transientMessage(worker, failure)
          : `boxd preflight ${failure.operation} failed: ${failure.code}: ${failure.message}. Check the API endpoint and snapshot; build it with boxd snapshots save.`;
  return WorkerCapabilityError.make({
    worker,
    capability: "provider",
    message,
    cause: new Error(message),
  });
};

/**
 * Explains a failure while connecting to the region of `worker`: a `MachineUnavailableError`,
 * which the scheduler retries, when boxd doesn't answer or rate-limits, otherwise the
 * `boxdPreflightError`.
 */
export const boxdConnectError = (
  worker: WorkerName,
  failure: BoxdCallError | BoxdUnknownRegion,
): MachineUnavailableError | WorkerCapabilityError =>
  failure._tag === "BoxdCallError" && transientCodes.has(failure.code)
    ? MachineUnavailableError.make({
        worker,
        provider: "boxd",
        reason: reasonOf(failure.code),
        message: transientMessage(worker, failure),
      })
    : boxdPreflightError(worker, failure);

/** A driver retains the create response only until endpoint discovery consumes it. */
export const boxdDriverFor = (worker: WorkerName, settings: BoxdProvisioner) =>
  Effect.gen(function* () {
    const api = yield* BoxdApi;
    const created = new Map<MachineId, BoxdMachine>();
    let hostKey: Option.Option<string> = Option.none();
    const hostKeyLock = yield* Semaphore.make(1);
    const proxyKey = Effect.gen(function* () {
      if (Option.isSome(hostKey)) return hostKey;
      const key = yield* api.sshHostKey;
      hostKey = Option.some(key);
      return hostKey;
    }).pipe(hostKeyLock.withPermit);
    const unavailable = (code: string, message: string) =>
      MachineUnavailableError.make({ worker, provider: "boxd", reason: reasonOf(code), message });
    const apiError = (operation: string) => (failure: BoxdCallError) =>
      ProviderApiError.make({
        provider: "boxd",
        operation,
        status: Option.none(),
        message: `boxd couldn't ${operation}: ${failure.code}: ${failure.message}`,
      });
    const capability = (message: string) =>
      WorkerCapabilityError.make({
        worker,
        capability: "provider",
        message,
        cause: new Error(message),
      });
    const verify = Effect.fn("BoxdDriver.verify")(
      function* (_worker: WorkerName, maxConcurrentAttempts: number) {
        yield* Effect.annotateCurrentSpan({ worker, region: settings.region });
        yield* api.whoami;
        const snapshot = yield* api.snapshot(settings.snapshot);
        if (snapshot.status !== "ready")
          return yield* capability(
            `boxd snapshot "${settings.snapshot}" is ${snapshot.status}; wait for it to be ready or rebuild it with boxd snapshots save.`,
          );
        if (snapshot.region !== settings.region)
          return yield* capability(
            `boxd snapshot "${settings.snapshot}" is in ${snapshot.region}; set provisioner.region to that region or rebuild it in ${settings.region}.`,
          );
        const vcpu = Number(settings.size.split("x")[0]);
        if (snapshot.vcpu !== vcpu || snapshot.memoryBytes !== vcpu * 4 * 1024 ** 3)
          return yield* capability(
            `boxd snapshot "${settings.snapshot}" captured ${snapshot.vcpu} vCPU and ${snapshot.memoryBytes / 1024 ** 3} GiB, but provisioner.size is ${settings.size}. Rebuild the snapshot at ${settings.size} or change size to match the captured size.`,
          );
        const { thisRegion } = yield* api.regions;
        if (thisRegion !== settings.region)
          return yield* capability(
            `boxd endpoint serves ${thisRegion}; use the endpoint for provisioner.region ${settings.region}.`,
          );
        const limit = yield* api.orgMachineLimit;
        const warnings =
          limit.maxVms - limit.vmCount < maxConcurrentAttempts
            ? [
                `boxd has ${limit.maxVms - limit.vmCount} machine slots available, fewer than max_concurrent_attempts (${maxConcurrentAttempts}). Free machines or request a higher machine limit.`,
              ]
            : [];
        yield* Effect.logInfo("boxd provisioner verified", {
          worker,
          region: settings.region,
          egress: Option.match(settings.egress, {
            onNone: () => "unrestricted",
            onSome: (entries) => `${entries.length} entries`,
          }),
          warnings,
        });
        return { warnings };
      },
      (effect) =>
        effect.pipe(
          Effect.catchTag("BoxdCallError", (failure) =>
            Effect.fail(boxdPreflightError(worker, failure)),
          ),
        ),
    );
    /**
     * Replaces the egress allowlist of machine `id` with `entries` and fails when boxd leaves a
     * restricted machine unrestricted, so no attempt runs on it.
     */
    const restrictEgress = Effect.fn("BoxdDriver.restrictEgress")(function* (
      id: MachineId,
      entries: BoxdEgressAllowlist,
    ) {
      yield* Effect.annotateCurrentSpan({ worker, machine: id });
      const inEffect = yield* api.setEgressAllow(id, entries);
      if (inEffect.length === 0)
        return yield* BoxdCallError.make({
          operation: EGRESS_OPERATION,
          code: "FAILED_PRECONDITION",
          message: `boxd reported unrestricted egress after usine set ${entries.length} entries`,
        });
      yield* Effect.logInfo("Restricted boxd machine egress", {
        worker,
        machine: id,
        entries: inEffect.length,
      });
    });
    const create = Effect.fn("BoxdDriver.create")(
      function* (name: string, tags: MachineTags) {
        yield* Effect.annotateCurrentSpan({ worker, attemptId: tags.attempt });
        const result = yield* api.createFromSnapshot({
          snapshot: settings.snapshot,
          name,
          isolated: settings.isolated,
          config: { network: { ssh: true } },
          labels: {
            "usine.instance": tagValue(tags.instance),
            "usine.worker": tagValue(tags.worker),
            ...assignment(tags),
          },
        });
        yield* Effect.gen(function* () {
          if (Option.isSome(settings.egress))
            yield* restrictEgress(result.id, settings.egress.value);
          yield* api.setAutoHibernateTimeout(result.id, 0);
          yield* api.setAutoSuspendTimeout(result.id, 0);
          // The timer calls count toward the time boxd takes to enforce the allowlist.
          if (Option.isSome(settings.egress)) yield* Effect.sleep(EGRESS_IN_FORCE);
        }).pipe(
          Effect.onError(() =>
            api.destroy(result.id).pipe(
              Effect.tap(() =>
                Effect.logInfo("Deleted boxd machine after its setup failed", {
                  worker,
                  machine: result.id,
                }),
              ),
              Effect.tapError((failure) =>
                Effect.logWarning("Could not delete boxd machine after its setup failed", {
                  worker,
                  machine: result.id,
                  code: failure.code,
                }),
              ),
              Effect.ignore,
            ),
          ),
        );
        if (Option.isSome(result.machine)) created.set(result.id, result.machine.value);
        yield* Effect.logInfo("Created boxd machine", { worker, machine: result.id });
        return { id: result.id, hostKey: Option.none<string>() };
      },
      (effect) =>
        effect.pipe(
          Effect.mapError((failure) =>
            unavailable(
              failure.code,
              failure.operation === EGRESS_OPERATION
                ? `boxd didn't apply provisioner.egress to the new machine, which usine deleted: ${failure.message}`
                : `boxd didn't create the machine: ${failure.message}`,
            ),
          ),
        ),
    );
    const connectionError = (message: string) =>
      ProviderApiError.make({
        provider: "boxd",
        operation: "read the machine connection",
        status: Option.none(),
        message,
      });
    const endpointOf = Effect.fn("BoxdDriver.endpointOf")(function* (machine: BoxdMachine) {
      if (machine.status !== "running" || machine.sshPort === 0 || machine.sshDisabled)
        return yield* connectionError(
          `boxd machine ${machine.id} is ${machine.status} or has SSH disabled`,
        );
      const destination = yield* Schema.decodeEffect(SshDestination)(
        `boxd@${machine.publicIp}`,
      ).pipe(Effect.mapError(() => connectionError("boxd returned an invalid SSH address")));
      const key = yield* proxyKey;
      return {
        destination,
        port: Option.some(SshPort.make(machine.sshPort)),
        hostKey: key,
      } satisfies MachineEndpoint;
    });
    const endpoint = Effect.fn("BoxdDriver.endpoint")(
      function* (id: MachineId, interval: Effect.Effect<void>) {
        yield* Effect.annotateCurrentSpan({ worker, machine: id });
        let initial = Option.fromUndefinedOr(created.get(id));
        created.delete(id);
        while (true) {
          const machine = Option.isSome(initial) ? initial.value : yield* api.vm(id);
          initial = Option.none();
          if (machine.status === "running" && machine.sshPort > 0)
            return yield* endpointOf(machine);
          if (terminalStates.has(machine.status))
            return yield* MachineUnavailableError.make({
              worker,
              provider: "boxd",
              reason: "capacity",
              message: `The new boxd machine ended in state ${machine.status}`,
            });
          yield* Effect.logDebug("Waiting for boxd machine", {
            worker,
            machine: id,
            status: machine.status,
          });
          yield* interval;
        }
      },
      (effect) =>
        effect.pipe(
          Effect.catchTags({
            ProviderApiError: (failure) =>
              MachineUnavailableError.make({
                worker,
                provider: "boxd",
                reason: "provider",
                message: failure.message,
              }),
            BoxdCallError: (failure) =>
              Effect.fail(
                failure.code === "NOT_FOUND"
                  ? MachineUnavailableError.make({
                      worker,
                      provider: "boxd",
                      reason: "capacity",
                      message: "boxd removed the new machine before it was ready",
                    })
                  : unavailable(
                      failure.code,
                      `boxd couldn't ready the machine: ${failure.message}`,
                    ),
              ),
          }),
        ),
    );
    const refreshEndpoint = Effect.fn("BoxdDriver.refreshEndpoint")(function* (id: MachineId) {
      yield* Effect.annotateCurrentSpan({ worker, machine: id });
      const machine = yield* api.vm(id).pipe(
        Effect.asSome,
        Effect.catchIf(
          (failure) => failure.code === "NOT_FOUND",
          () => Effect.succeed(Option.none<BoxdMachine>()),
        ),
        Effect.mapError(apiError("refresh the machine connection")),
      );
      if (Option.isNone(machine) || terminalStates.has(machine.value.status)) {
        yield* Effect.logInfo("boxd machine is gone", {
          worker,
          machine: id,
          status: Option.isSome(machine) ? machine.value.status : "not found",
        });
        return Option.none<MachineEndpoint>();
      }
      return yield* endpointOf(machine.value).pipe(
        Effect.asSome,
        Effect.catchTag("BoxdCallError", (failure) =>
          apiError("refresh the machine connection")(failure),
        ),
      );
    });
    const assign = Effect.fn("BoxdDriver.assign")(function* (id: MachineId, tags: MachineTags) {
      yield* Effect.annotateCurrentSpan({ worker, machine: id, attemptId: tags.attempt });
      yield* Effect.gen(function* () {
        yield* api.updateLabels(id, assignment(tags));
        yield* Option.match(settings.egress, {
          onNone: () =>
            api.setEgressAllow(id, []).pipe(
              Effect.tap(() =>
                Effect.logInfo("Cleared boxd machine egress allowlist for reuse", {
                  worker,
                  machine: id,
                }),
              ),
            ),
          onSome: (entries) => restrictEgress(id, entries),
        });
        yield* api.setAutoHibernateTimeout(id, 0);
        yield* api.setAutoSuspendTimeout(id, 0);
      }).pipe(Effect.mapError(apiError("assign the machine")));
      yield* Effect.logInfo("Assigned boxd machine to attempt", {
        worker,
        machine: id,
        attemptId: tags.attempt,
      });
    });
    const remove = Effect.fn("BoxdDriver.remove")(function* (id: MachineId) {
      yield* Effect.annotateCurrentSpan({ worker, machine: id });
      created.delete(id);
      yield* api.destroy(id).pipe(
        Effect.catchIf(
          (failure) => failure.code === "NOT_FOUND",
          () => Effect.void,
        ),
        Effect.mapError(apiError("delete the machine")),
      );
      yield* Effect.logInfo("Deleted boxd machine", { worker, machine: id });
    });
    const list = Effect.fn("BoxdDriver.list")(function* (
      instance: string,
      listed: Option.Option<WorkerName>,
    ) {
      yield* Effect.annotateCurrentSpan({
        instance,
        worker: Option.getOrElse(listed, () => "all"),
      });
      const selector = [
        `usine.instance=${tagValue(instance)}`,
        ...Option.match(listed, {
          onNone: () => [],
          onSome: (name) => [`usine.worker=${tagValue(name)}`],
        }),
      ];
      return (yield* api.listVms(selector).pipe(Effect.mapError(apiError("list machines")))).map(
        (machine) => ({
          id: machine.id,
          tags: {
            worker: machine.labels["usine.worker"] ?? "",
            run: machine.labels["usine.run"] ?? "",
            process: machine.labels["usine.process"] ?? "",
            attempt: Option.fromUndefinedOr(machine.labels["usine.attempt"]),
          },
          attempts: attemptsFromTag(machine.labels["usine.attempts"]),
          createdAt: DateTime.makeUnsafe(machine.createdAt * 1000),
        }),
      );
    });
    return {
      provider: "boxd",
      verify,
      create,
      endpoint,
      refreshEndpoint,
      assign,
      remove,
      list,
    } satisfies MachineDriver;
  });

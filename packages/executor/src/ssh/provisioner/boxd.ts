import {
  type BoxdEgressAllowlist,
  isBoxdEgressAddress,
  MachineId,
  type WorkerName,
} from "@usine/core/worker";
import { type Brand, DateTime, Effect, Option, type Redacted, Schema } from "effect";
import {
  MachineUnavailableError,
  WorkerCapabilityError,
  type MachineUnavailableReason,
} from "../../executor.ts";
import type { BoxdProvisioner } from "../model.ts";
import { BoxdApi, BoxdCallError, type BoxdMachine, type BoxdUnknownRegion } from "./boxd/client.ts";
import { BoxdExec, boxdTransport } from "./boxd/exec.ts";
import {
  attemptTag,
  attemptsFromTag,
  ProviderApiError,
  tagValue,
  type MachineDriver,
  MachineEndpoint,
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

/** Whether a later call can outlast `code`: boxd doesn't answer or rate-limits. */
const isTransient = (code: string): boolean => {
  const reason = reasonOf(code);
  return reason === "unreachable" || reason === "quota";
};

const terminalStates = new Set(["stopped", "failed", "destroyed"]);

/**
 * How long after the create response a restored machine's resumed processes may still reach hosts
 * outside the allowlist of its spec (question 23 of `docs/research/boxd-attempt-machine-sources.md`).
 */
const EGRESS_IN_FORCE = "1 second";

/**
 * The error when boxd accepts an egress allowlist but reports an empty list in effect, which leaves
 * the machine's egress unrestricted.
 */
class BoxdEgressNotApplied extends Schema.TaggedError<
  BoxdEgressNotApplied,
  Brand.Brand<"@usine/executor/boxd/BoxdEgressNotApplied">
>()("BoxdEgressNotApplied", {
  machine: MachineId,
  requested: Schema.Int,
}) {}

const assignment = (tags: MachineTags) => ({
  "usine.run": tagValue(tags.run),
  "usine.process": tagValue(tags.process),
  "usine.attempt": attemptTag(tags.attempt),
  "usine.attempts": String(tags.attempts),
});

const transientMessage = (worker: WorkerName, failure: BoxdCallError): string =>
  `boxd didn't answer ${failure.operation} for worker "${worker}": ${failure.code}: ${failure.message}. Check that this host reaches app.boxd.sh, boxd.sh:9443, and the API endpoint of the region, or wait for the boxd rate limit to reset.`;

/** Returns the configuration fault of `worker`'s boxd provisioner that `message` explains. */
const providerFault = (worker: WorkerName, message: string): WorkerCapabilityError =>
  WorkerCapabilityError.make({
    worker,
    capability: "provider",
    message,
    cause: new Error(message),
  });

/** Explains a boxd failure at preflight or while connecting to the region, naming the fix. */
export const boxdPreflightError = (
  worker: WorkerName,
  failure: BoxdCallError | BoxdUnknownRegion,
): WorkerCapabilityError =>
  providerFault(
    worker,
    failure._tag === "BoxdUnknownRegion"
      ? `boxd has no region "${failure.region}" with an API endpoint. Set provisioner.region of worker "${worker}" to one of the regions boxd lists: ${failure.available.join(", ") || "none"}.`
      : failure.code === "UNAUTHENTICATED" || failure.code === "PERMISSION_DENIED"
        ? `boxd refused the API key of worker "${worker}". Create one with boxd auth keys create usine --kind member and set provisioner.token_env.`
        : isTransient(failure.code)
          ? transientMessage(worker, failure)
          : `boxd preflight couldn't ${failure.operation}: ${failure.code}: ${failure.message}.${failure.operation === "snapshot" ? " Check the snapshot; build it with boxd snapshots save." : ""}`,
  );

/**
 * Explains a failure while connecting to the region of `worker`: a `MachineUnavailableError`,
 * which the scheduler retries, when boxd doesn't answer or rate-limits, otherwise the
 * `boxdPreflightError`.
 */
export const boxdConnectError = (
  worker: WorkerName,
  failure: BoxdCallError | BoxdUnknownRegion,
): MachineUnavailableError | WorkerCapabilityError =>
  failure._tag === "BoxdCallError" && isTransient(failure.code)
    ? MachineUnavailableError.make({
        worker,
        provider: "boxd",
        reason: reasonOf(failure.code),
        message: transientMessage(worker, failure),
      })
    : boxdPreflightError(worker, failure);

/**
 * Returns the bearer of the `Exec` calls: the API key itself. boxd accepts it as a bearer without
 * documenting it (question 3 of `docs/research/boxd-byoc.md`). A session token file that the
 * orchestrator renews can replace it here.
 */
export const execCredential = (settings: BoxdProvisioner): Redacted.Redacted<string> =>
  settings.token;

/**
 * Returns the boxd driver for `worker`. Its machines' endpoints are `Exec` endpoints, which run
 * commands through `BoxdExec` with the API key, so no SSH key is involved: preflight warns that
 * `identityFile`, the worker's `identity_file`, is ignored. A driver retains the create response
 * only until endpoint discovery consumes it.
 */
export const boxdDriverFor = (
  worker: WorkerName,
  settings: BoxdProvisioner,
  identityFile: Option.Option<string> = Option.none(),
) =>
  Effect.gen(function* () {
    const api = yield* BoxdApi;
    const exec = yield* BoxdExec;
    const created = new Map<MachineId, BoxdMachine>();
    const unavailable = (code: string, message: string) =>
      MachineUnavailableError.make({ worker, provider: "boxd", reason: reasonOf(code), message });
    const apiError = (operation: string) => (failure: BoxdCallError) =>
      ProviderApiError.make({
        provider: "boxd",
        operation,
        status: Option.none(),
        message: `boxd couldn't ${operation}: ${failure.code}: ${failure.message}`,
      });
    const capability = (message: string) => providerFault(worker, message);
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
        const served = yield* api.servedRegion;
        if (served !== settings.region)
          return yield* capability(
            `boxd endpoint ${api.endpoint}, set by providerEndpoints.boxd, serves region ${served}, but provisioner.region of worker "${worker}" is ${settings.region}. Set providerEndpoints.boxd to the API endpoint of ${settings.region}, or remove it so usine finds the endpoint in boxd's region list.`,
          );
        const limit = yield* api.orgMachineLimit;
        const addresses = Option.isSome(settings.tailnet)
          ? Option.getOrElse(settings.egress, () => []).filter(isBoxdEgressAddress)
          : [];
        const warnings = [
          ...Option.match(identityFile, {
            onNone: () => [],
            onSome: (file) => [
              `Worker "${worker}" sets identity_file ${file}, which usine ignores: it runs commands on boxd machines through boxd's Exec API with the API key. Remove identity_file from the worker.`,
            ],
          }),
          ...(limit.maxVms - limit.vmCount < maxConcurrentAttempts
            ? [
                `boxd has ${limit.maxVms - limit.vmCount} machine slots available, fewer than max_concurrent_attempts (${maxConcurrentAttempts}). Free machines or request a higher machine limit.`,
              ]
            : []),
          ...(snapshot.storage !== "" && snapshot.storage !== "local"
            ? [
                `boxd snapshot "${settings.snapshot}" is ${snapshot.storage}, and boxd creates machines only from a local snapshot, so machine creation can fail until boxd restores it. Restore the snapshot or rebuild it with boxd snapshots save.`,
              ]
            : []),
          ...(addresses.length > 0
            ? [
                `provisioner.egress admits the addresses ${addresses.join(", ")}, which usine can't check against the gateway. Make sure none of them belongs to GitHub or to a provider the gateway serves, or attempts can reach it without the gateway.`,
              ]
            : []),
        ];
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
     * Replaces the egress allowlist of reused machine `id` with `entries` and fails when boxd leaves
     * a restricted machine unrestricted, so no attempt runs on it.
     */
    const restrictEgress = Effect.fn("BoxdDriver.restrictEgress")(function* (
      id: MachineId,
      entries: BoxdEgressAllowlist,
    ) {
      yield* Effect.annotateCurrentSpan({ worker, machine: id });
      const inEffect = yield* api.setEgressAllow(id, entries);
      if (inEffect.length === 0)
        return yield* BoxdEgressNotApplied.make({ machine: id, requested: entries.length });
      yield* Effect.logInfo("Restricted boxd machine egress", {
        worker,
        machine: id,
        entries: inEffect.length,
      });
    });
    /**
     * Fails when boxd reports new machine `id`, created with `entries` in its spec, unrestricted.
     * Reads the machine when the create response, `machine`, omits it.
     */
    const checkEgress = Effect.fn("BoxdDriver.checkEgress")(function* (
      id: MachineId,
      machine: Option.Option<BoxdMachine>,
      entries: BoxdEgressAllowlist,
    ) {
      yield* Effect.annotateCurrentSpan({ worker, machine: id });
      const inEffect = Option.isSome(machine)
        ? machine.value.egressAllow
        : (yield* api.vm(id)).egressAllow;
      if (inEffect.length === 0)
        return yield* BoxdEgressNotApplied.make({ machine: id, requested: entries.length });
      yield* Effect.logInfo("Created boxd machine with restricted egress", {
        worker,
        machine: id,
        entries: inEffect.length,
      });
    });
    /**
     * Explains a failed creation of machine `name`. A request that boxd refuses as invalid, such as
     * a reserved name or an allowlist entry, fails the same way on retry, so it is a fault of the
     * worker's configuration.
     */
    const creationError = (name: string, failure: BoxdCallError) =>
      failure.operation === "createFromSnapshot" && failure.code === "INVALID_ARGUMENT"
        ? capability(
            `boxd refused to create machine "${name}" from snapshot "${settings.snapshot}": ${failure.message}. If boxd refuses the name, rename worker "${worker}"; otherwise check its provisioner settings, such as provisioner.egress.`,
          )
        : unavailable(failure.code, `boxd didn't create the machine: ${failure.message}`);
    const create = Effect.fn("BoxdDriver.create")(
      function* (name: string, tags: MachineTags) {
        yield* Effect.annotateCurrentSpan({ worker, attemptId: tags.attempt });
        const result = yield* api.createFromSnapshot({
          snapshot: settings.snapshot,
          name,
          isolated: settings.isolated,
          labels: {
            "usine.instance": tagValue(tags.instance),
            "usine.worker": tagValue(tags.worker),
            ...assignment(tags),
          },
          egress: Option.getOrElse(settings.egress, () => []),
        });
        const setup = Effect.gen(function* () {
          if (Option.isSome(settings.egress))
            yield* checkEgress(result.id, result.machine, settings.egress.value);
          yield* api.setAutoHibernateTimeout(result.id, 0);
          yield* api.setAutoSuspendTimeout(result.id, 0);
        });
        // Nothing connects to a restricted machine before its allowlist is fully in force.
        yield* Effect.all(
          [setup, Option.isSome(settings.egress) ? Effect.sleep(EGRESS_IN_FORCE) : Effect.void],
          { concurrency: "unbounded", discard: true },
        ).pipe(
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
      (effect, name) =>
        effect.pipe(
          Effect.catchTags({
            BoxdEgressNotApplied: (failure) =>
              Effect.fail(
                MachineUnavailableError.make({
                  worker,
                  provider: "boxd",
                  reason: "provider",
                  message: `boxd reported unrestricted egress on the new machine created with ${failure.requested} provisioner.egress entries, which usine deleted`,
                }),
              ),
            BoxdCallError: (failure) => Effect.fail(creationError(name, failure)),
          }),
        ),
    );
    const endpointOf = (id: MachineId) =>
      MachineEndpoint.Exec({ machine: id, transport: boxdTransport(exec, id) });
    const endpoint = Effect.fn("BoxdDriver.endpoint")(
      function* (id: MachineId, interval: Effect.Effect<void>) {
        yield* Effect.annotateCurrentSpan({ worker, machine: id });
        let initial = Option.fromUndefinedOr(created.get(id));
        created.delete(id);
        while (true) {
          const machine = Option.isSome(initial) ? initial.value : yield* api.vm(id);
          initial = Option.none();
          if (machine.status === "running") return endpointOf(id);
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
      return Option.some(endpointOf(id));
    });
    const assign = Effect.fn("BoxdDriver.assign")(function* (id: MachineId, tags: MachineTags) {
      yield* Effect.annotateCurrentSpan({ worker, machine: id, attemptId: tags.attempt });
      yield* Effect.gen(function* () {
        yield* api.updateLabels(id, assignment(tags));
        if (Option.isSome(settings.egress)) yield* restrictEgress(id, settings.egress.value);
        yield* api.setAutoHibernateTimeout(id, 0);
        yield* api.setAutoSuspendTimeout(id, 0);
      }).pipe(
        Effect.catchTags({
          BoxdEgressNotApplied: (failure) =>
            Effect.fail(
              ProviderApiError.make({
                provider: "boxd",
                operation: "assign the machine",
                status: Option.none(),
                message: `boxd reported unrestricted egress after usine set ${failure.requested} provisioner.egress entries on machine ${failure.machine}`,
              }),
            ),
          BoxdCallError: (failure) => Effect.fail(apiError("assign the machine")(failure)),
        }),
      );
      yield* Effect.logInfo("Assigned boxd machine to attempt", {
        worker,
        machine: id,
        attemptId: tags.attempt,
      });
    });
    const remove = Effect.fn("BoxdDriver.remove")(function* (id: MachineId) {
      yield* Effect.annotateCurrentSpan({ worker, machine: id });
      created.delete(id);
      const deleted = yield* api.destroy(id).pipe(
        Effect.as(true),
        Effect.catchIf(
          (failure) => failure.code === "NOT_FOUND",
          () => Effect.succeed(false),
        ),
        Effect.mapError(apiError("delete the machine")),
      );
      yield* deleted
        ? Effect.logInfo("Deleted boxd machine", { worker, machine: id })
        : Effect.logInfo("boxd machine was already deleted", { worker, machine: id });
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

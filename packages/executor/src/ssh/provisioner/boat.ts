import { MachineId, SshDestination, SshPort, type WorkerName } from "@usine/core/worker";
import { DateTime, Effect, Option, Schema } from "effect";
import {
  MachineUnavailableError,
  type MachineUnavailableReason,
  WorkerCapabilityError,
} from "../../executor.ts";
import type { BoatProvisioner } from "../model.ts";
import { failureText, type ProviderFailure, providerApiFor } from "./http.ts";
import {
  attemptTag,
  type HostKey,
  type ListedMachine,
  type MachineDriver,
  type MachineTags,
  ProviderApiError,
  tagValue,
} from "./model.ts";

/** Boat's public API. */
export const BOAT_API = "https://boat.dev/api/v1";

/** The prefix of the name of every sandbox that usine creates. */
const NAME_PREFIX = "usine";

const Sandbox = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  state: Schema.String,
  error: Schema.optionalKey(Schema.NullOr(Schema.String)),
  createdAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const OneSandbox = Schema.Struct({ sandbox: Sandbox });

const SandboxList = Schema.Struct({
  sandboxes: Schema.Array(Sandbox),
  pageInfo: Schema.optionalKey(
    Schema.Struct({ nextCursor: Schema.NullOr(Schema.String), hasMore: Schema.Boolean }),
  ),
});

const SshKey = Schema.Struct({
  machineIp: Schema.optionalKey(Schema.NullOr(Schema.String)),
  sshUser: Schema.optionalKey(Schema.String),
  sshEndpoint: Schema.optionalKey(Schema.NullOr(Schema.String)),
  hostKey: Schema.optionalKey(Schema.String),
});

const Limits = Schema.Struct({
  canStart: Schema.optionalKey(Schema.Boolean),
  activeSandboxes: Schema.optionalKey(Schema.Int),
  maxActiveSandboxes: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  starts: Schema.optionalKey(
    Schema.Struct({
      unlimited: Schema.optionalKey(Schema.Boolean),
      day: Schema.optionalKey(Schema.Struct({ remaining: Schema.NullOr(Schema.Int) })),
    }),
  ),
  machineTypes: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        type: Schema.String,
        available: Schema.Boolean,
        reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

/** The states in which a sandbox accepts SSH. */
const RUNNING = new Set(["ready", "idle", "running"]);
/** The states from which a new sandbox never runs. */
const ENDED = new Set(["error", "cancelled", "archiving", "archived"]);

/** Returns the name that carries a sandbox's tags; at most 120 characters, Boat's limit. */
const nameOf = (tags: MachineTags): string =>
  [
    NAME_PREFIX,
    tagValue(tags.instance, 24),
    tagValue(tags.worker, 24),
    tagValue(tags.run, 32),
    tagValue(tags.process, 12),
    Option.match(tags.attempt, { onNone: () => "-", onSome: attemptTag }),
  ].join(" ");

/** Returns the reason a creation failure is retried, by Boat's documented statuses. */
const creationReason = (failure: ProviderFailure): MachineUnavailableReason => {
  if (failure._tag === "ProviderUnanswered") return "unreachable";
  if (failure.status === 503) return "capacity";
  if (failure.status === 402 || failure.status === 429) return "quota";
  if (failure.status === 401 || failure.status === 403 || failure.status === 400) return "refused";
  return "provider";
};

/** Returns where to connect: Boat's `sshEndpoint` forward if set, else the machine's address. */
const destinationOf = (
  answer: typeof SshKey.Type,
): Option.Option<{ readonly host: string; readonly port: Option.Option<SshPort> }> => {
  const forwarded = answer.sshEndpoint ?? undefined;
  if (forwarded !== undefined) {
    const separator = forwarded.lastIndexOf(":");
    const port = Number(forwarded.slice(separator + 1));
    if (separator > 0 && Number.isInteger(port) && port > 0 && port < 65_536)
      return Option.some({
        host: forwarded.slice(0, separator),
        port: Option.some(SshPort.make(port)),
      });
  }
  return Option.map(Option.fromNullishOr(answer.machineIp), (host) => ({
    host,
    port: Option.none(),
  }));
};

/**
 * Returns the Boat driver for `worker`'s sandboxes (#550). Each sandbox is created with none of
 * the account's secrets (`noEnv`), no snapshots, which Boat can store outside the EU, no command
 * monitoring, and no automatic stop, and the executor deletes it. Its name carries the instance,
 * Worker, Run, creating process, and Attempt, because Boat has no labels. `publicKey` is the
 * OpenSSH public key each sandbox authorizes.
 */
export const boatDriverFor = (
  worker: WorkerName,
  settings: BoatProvisioner,
  publicKey: string,
  base: string = BOAT_API,
) =>
  Effect.gen(function* () {
    const api = yield* providerApiFor("boat", base, settings.token);

    const apiError = (operation: string) => (failure: ProviderFailure) =>
      new ProviderApiError({
        provider: "boat",
        operation,
        status: failure._tag === "ProviderRefused" ? Option.some(failure.status) : Option.none(),
        message: `Boat couldn't ${operation}: ${failureText(failure)}`,
      });

    const providerGap = (message: string, cause: unknown) =>
      new WorkerCapabilityError({ worker, capability: "provider", message, cause });

    const unavailable = (reason: MachineUnavailableReason, message: string) =>
      new MachineUnavailableError({ worker, provider: "boat", reason, message });

    const verify = Effect.fn("BoatDriver.verify")(
      function* (_worker: WorkerName, maxConcurrentAttempts: number) {
        yield* Effect.annotateCurrentSpan({ worker, maxConcurrentAttempts });
        yield* api.send("GET", "/me");
        const limits = yield* api
          .send("GET", "/limits")
          .pipe(Effect.flatMap(api.decode(Limits, "read the limits")));
        const machineType = limits.machineTypes?.find(({ type }) => type === settings.size);
        if (machineType !== undefined && !machineType.available)
          return yield* providerGap(
            `Boat doesn't offer machine size ${settings.size} to the account of worker "${worker}"${
              machineType.reason === undefined || machineType.reason === null
                ? ""
                : `: ${machineType.reason}`
            }`,
            new Error(`size ${settings.size} unavailable`),
          );
        const maximum = limits.maxActiveSandboxes ?? undefined;
        const warnings = [
          ...(limits.canStart === false
            ? [`Boat reports that the account of worker "${worker}" can't start sandboxes now.`]
            : []),
          ...(maximum !== undefined && maximum < maxConcurrentAttempts
            ? [
                `Boat allows ${String(maximum)} active sandboxes, fewer than max_concurrent_attempts (${String(maxConcurrentAttempts)}).`,
              ]
            : []),
        ];
        yield* Effect.logInfo("Boat provisioner verified", {
          worker,
          size: settings.size,
          canStart: limits.canStart ?? "not reported",
          activeSandboxes: limits.activeSandboxes ?? "not reported",
          maxActiveSandboxes: maximum ?? "not reported",
          startsLeftToday:
            limits.starts?.unlimited === true
              ? "unlimited"
              : (limits.starts?.day?.remaining ?? "not reported"),
        });
        return { warnings };
      },
      (effect) =>
        effect.pipe(
          Effect.catchTags({
            ProviderUnanswered: (failure) =>
              Effect.fail(
                providerGap(
                  `Can't reach the Boat API for worker "${worker}": ${failure.detail}`,
                  failure,
                ),
              ),
            ProviderRefused: (failure) =>
              Effect.fail(
                providerGap(
                  failure.status === 401
                    ? `Boat refused the API key of worker "${worker}". Create one with boat api-key create, and set it in provisioner.token_env.`
                    : `Boat refused a preflight request of worker "${worker}": ${failureText(failure)}`,
                  failure,
                ),
              ),
          }),
        ),
    );

    const create = Effect.fn("BoatDriver.create")(
      function* (_name: string, tags: MachineTags) {
        yield* Effect.annotateCurrentSpan({ worker, run: tags.run });
        const response = yield* api.send("POST", "/sandboxes", {
          body: {
            type: settings.size,
            name: nameOf(tags),
            ttlSeconds: null,
            noEnv: true,
            snapshots: false,
            monitoring: false,
            failFast: true,
          },
        });
        const created = yield* api.decode(OneSandbox, "create a sandbox")(response);
        return MachineId.make(created.sandbox.id);
      },
      (effect) =>
        effect.pipe(
          Effect.catchTags({
            ProviderUnanswered: (failure) =>
              Effect.fail(
                unavailable(
                  "unreachable",
                  `Can't reach the Boat API to create a sandbox: ${failure.detail}`,
                ),
              ),
            ProviderRefused: (failure) =>
              Effect.fail(
                unavailable(
                  creationReason(failure),
                  `Boat didn't create a ${settings.size} sandbox: ${failureText(failure)}`,
                ),
              ),
          }),
        ),
    );

    const endpoint = Effect.fn("BoatDriver.endpoint")(
      function* (id: MachineId, interval: Effect.Effect<void>) {
        yield* Effect.annotateCurrentSpan({ worker, machine: id });
        while (true) {
          const { sandbox } = yield* api
            .send("GET", `/sandboxes/${id}`)
            .pipe(Effect.flatMap(api.decode(OneSandbox, "read the sandbox")));
          if (RUNNING.has(sandbox.state)) break;
          if (ENDED.has(sandbox.state))
            return yield* unavailable(
              "capacity",
              `The new Boat sandbox ended in state ${sandbox.state}${
                sandbox.error === undefined || sandbox.error === null ? "" : `: ${sandbox.error}`
              }`,
            );
          yield* Effect.logDebug("Waiting for the Boat sandbox to be ready", {
            worker,
            machine: id,
            state: sandbox.state,
          });
          yield* interval;
        }
        const answer = yield* api
          .send("POST", `/sandboxes/${id}/sshkey`, { body: { key: publicKey } })
          .pipe(Effect.flatMap(api.decode(SshKey, "add the SSH key")));
        const target = destinationOf(answer);
        if (Option.isNone(target))
          return yield* unavailable("provider", "Boat reported no SSH address for the new sandbox");
        const user = answer.sshUser ?? "user";
        const hostKey: HostKey =
          answer.hostKey === undefined
            ? { _tag: "FirstUse" }
            : { _tag: "Pinned", key: answer.hostKey };
        return {
          destination: SshDestination.make(`${user}@${target.value.host}`),
          port: target.value.port,
          hostKey,
        };
      },
      (effect) =>
        effect.pipe(
          Effect.catchTags({
            ProviderUnanswered: (failure) =>
              Effect.fail(
                unavailable(
                  "unreachable",
                  `Can't reach the Boat API to read a new sandbox: ${failure.detail}`,
                ),
              ),
            ProviderRefused: (failure) =>
              Effect.fail(
                unavailable(
                  failure.status === 404 ? "capacity" : creationReason(failure),
                  failure.status === 404
                    ? "Boat removed the new sandbox before it was ready"
                    : `Boat couldn't ready the new sandbox: ${failureText(failure)}`,
                ),
              ),
          }),
        ),
    );

    const tag = Effect.fn("BoatDriver.tag")(function* (id: MachineId, tags: MachineTags) {
      yield* Effect.annotateCurrentSpan({ worker, machine: id });
      yield* api
        .send("PATCH", `/sandboxes/${id}`, { body: { name: nameOf(tags) } })
        .pipe(Effect.mapError(apiError("rename the sandbox")));
    });

    const remove = Effect.fn("BoatDriver.remove")(function* (id: MachineId) {
      yield* Effect.annotateCurrentSpan({ worker, machine: id });
      yield* api
        .send("DELETE", `/sandboxes/${id}`, { headers: { "X-Ascii-Confirm-Delete": id } })
        .pipe(
          Effect.asVoid,
          Effect.catchIf(
            (failure) => failure._tag === "ProviderRefused" && failure.status === 404,
            () => Effect.void,
          ),
          Effect.mapError(apiError("delete the sandbox")),
        );
    });

    const list = Effect.fn("BoatDriver.list")(function* (instance: string, listed: WorkerName) {
      yield* Effect.annotateCurrentSpan({ worker: listed });
      const prefix = `${NAME_PREFIX} ${tagValue(instance, 24)} ${tagValue(listed, 24)} `;
      const machines: Array<ListedMachine> = [];
      let cursor: string | null = null;
      do {
        const query = new Map([["limit", "200"]]);
        if (cursor !== null) query.set("cursor", cursor);
        const page: typeof SandboxList.Type = yield* api
          .send("GET", "/sandboxes", { query: Object.fromEntries(query) })
          .pipe(
            Effect.flatMap(api.decode(SandboxList, "list sandboxes")),
            Effect.mapError(apiError("list the sandboxes")),
          );
        for (const sandbox of page.sandboxes) {
          if (!sandbox.name.startsWith(prefix)) continue;
          const [, , workerTag = "", run = "", process = "", attempt = "-"] =
            sandbox.name.split(" ");
          machines.push({
            id: MachineId.make(sandbox.id),
            tags: {
              worker: workerTag,
              run,
              process,
              attempt: attempt === "-" ? Option.none() : Option.some(attempt),
            },
            createdAt: Option.getOrElse(
              Option.flatMap(Option.fromNullishOr(sandbox.createdAt), (at) => DateTime.make(at)),
              () => DateTime.makeUnsafe(0),
            ),
          });
        }
        cursor = page.pageInfo?.hasMore === true ? page.pageInfo.nextCursor : null;
      } while (cursor !== null);
      return machines;
    });

    return {
      provider: "boat",
      verify,
      create,
      endpoint,
      tag,
      remove,
      list,
    } satisfies MachineDriver;
  });

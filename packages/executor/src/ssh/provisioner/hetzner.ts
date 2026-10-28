import { MachineId, SshDestination, type WorkerName } from "@usine/core/worker";
import { DateTime, Effect, Option, Redacted, Schema } from "effect";
import {
  MachineUnavailableError,
  type MachineUnavailableReason,
  WorkerCapabilityError,
} from "../../executor.ts";
import type { HetznerProvisioner } from "../model.ts";
import { generateHostKey, type HostKeyPair } from "./host-key.ts";
import {
  failureText,
  type ProviderFailure,
  type ProviderResponse,
  providerApiFor,
} from "./http.ts";
import {
  attemptTag,
  type ListedMachine,
  type MachineDriver,
  type MachineTags,
  ProviderApiError,
  tagValue,
} from "./model.ts";

/** The Hetzner Cloud API. */
export const HETZNER_API = "https://api.hetzner.cloud/v1";

const LABELS = {
  instance: "usine-instance",
  worker: "usine-worker",
  run: "usine-run",
  process: "usine-process",
  attempt: "usine-attempt",
} as const;

/**
 * Returns the cloud-init user data that replaces the image's SSH host keys with `hostKey` at the
 * server's first boot, so the executor knows the key before it connects. cloud-init runs it on a
 * server created from a snapshot too, because the new server has a new instance ID.
 */
const hostKeyUserData = (hostKey: HostKeyPair): string =>
  [
    "#cloud-config",
    "ssh_deletekeys: true",
    "ssh_genkeytypes: []",
    "ssh_keys:",
    "  ed25519_private: |",
    ...Redacted.value(hostKey.privateKey)
      .trimEnd()
      .split("\n")
      .map((line) => `    ${line}`),
    `  ed25519_public: ${hostKey.publicKey}`,
    "",
  ].join("\n");

const Pagination = Schema.Struct({
  meta: Schema.optionalKey(
    Schema.Struct({
      pagination: Schema.Struct({ next_page: Schema.NullOr(Schema.Int) }),
    }),
  ),
});

const Named = Schema.Struct({ id: Schema.Int, name: Schema.NullOr(Schema.String) });
const SshKeys = Schema.Struct({ ssh_keys: Schema.Array(Named) });
const Networks = Schema.Struct({ networks: Schema.Array(Named) });
const Firewalls = Schema.Struct({ firewalls: Schema.Array(Named) });

const ServerTypes = Schema.Struct({
  server_types: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      locations: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            name: Schema.String,
            available: Schema.optionalKey(Schema.Boolean),
          }),
        ),
      ),
    }),
  ),
});

const Image = Schema.Struct({
  id: Schema.Int,
  type: Schema.String,
  status: Schema.String,
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  created: Schema.optionalKey(Schema.String),
});

const Images = Schema.Struct({ images: Schema.Array(Image) });

const Server = Schema.Struct({
  id: Schema.Int,
  status: Schema.String,
  created: Schema.String,
  labels: Schema.Record(Schema.String, Schema.String),
  public_net: Schema.optionalKey(
    Schema.Struct({
      ipv4: Schema.optionalKey(Schema.NullOr(Schema.Struct({ ip: Schema.String }))),
    }),
  ),
  private_net: Schema.optionalKey(
    Schema.Array(Schema.Struct({ network: Schema.Int, ip: Schema.String })),
  ),
});

const Created = Schema.Struct({ server: Server });
const OneServer = Schema.Struct({ server: Server });
const Servers = Schema.Struct({ servers: Schema.Array(Server) });

/** Returns the reason a creation failure is retried, by Hetzner's documented error codes. */
const creationReason = (failure: ProviderFailure): MachineUnavailableReason => {
  if (failure._tag === "ProviderUnanswered") return "unreachable";
  const code = Option.getOrElse(failure.code, () => "");
  if (code === "resource_unavailable" || code === "unavailable" || code === "placement_error")
    return "capacity";
  if (code === "resource_limit_exceeded") return "quota";
  if (failure.status === 401 || failure.status === 403 || failure.status === 422) return "refused";
  return "provider";
};

/**
 * Returns the Hetzner Cloud driver for `worker`'s servers (#550). Each server is created from
 * `settings.image` with the project's SSH key, and labeled with the instance, Worker, Run,
 * creating process, and Attempt. With `privateOnly`, a server gets no public address and is
 * reached at its address on `settings.network`, through the Gateway.
 */
export const hetznerDriverFor = (
  worker: WorkerName,
  settings: HetznerProvisioner,
  privateOnly: boolean,
  base: string = HETZNER_API,
) =>
  Effect.gen(function* () {
    const api = yield* providerApiFor("hetzner", base, settings.token);

    const apiError = (operation: string) => (failure: ProviderFailure) =>
      new ProviderApiError({
        provider: "hetzner",
        operation,
        status: failure._tag === "ProviderRefused" ? Option.some(failure.status) : Option.none(),
        message: `Hetzner Cloud couldn't ${operation}: ${failureText(failure)}`,
      });

    const providerGap = (message: string, cause: unknown) =>
      new WorkerCapabilityError({ worker, capability: "provider", message, cause });

    /** Returns every page of a listing at `path`. */
    const listAll = <S extends Schema.Constraint>(
      path: string,
      query: Readonly<Record<string, string>>,
      schema: S,
      operation: string,
    ) =>
      Effect.gen(function* () {
        const pages: Array<S["Type"]> = [];
        let page: number | null = 1;
        while (page !== null) {
          const response: ProviderResponse = yield* api.send("GET", path, {
            query: { ...query, page: String(page), per_page: "50" },
          });
          pages.push(yield* api.decode(schema, operation)(response));
          const meta: typeof Pagination.Type = yield* api.decode(Pagination, operation)(response);
          page = meta.meta?.pagination.next_page ?? null;
        }
        return pages;
      });

    /** Returns the ID of `settings.image`: a numeric ID, a system image name, or the newest snapshot with that description. */
    const imageId = Effect.fn("HetznerDriver.imageId")(function* () {
      const image = settings.image;
      if (/^[0-9]+$/u.test(image)) {
        const response = yield* api.send("GET", `/images/${image}`);
        return (yield* api.decode(Schema.Struct({ image: Image }), "read the image")(response))
          .image.id;
      }
      const named = yield* listAll("/images", { name: image }, Images, "list images");
      const system = named.flatMap(({ images }) => images)[0];
      if (system !== undefined) return system.id;
      const snapshots = (yield* listAll(
        "/images",
        { type: "snapshot", status: "available" },
        Images,
        "list snapshots",
      ))
        .flatMap(({ images }) => images)
        .filter(({ description }) => description === image)
        .sort((left, right) => (right.created ?? "").localeCompare(left.created ?? ""));
      const newest = snapshots[0];
      if (newest === undefined)
        return yield* providerGap(
          `Hetzner Cloud has no snapshot or image "${image}" for worker "${worker}". Build one with infra/hetzner/snapshot.sh, or set provisioner.image to an existing one.`,
          new Error(`no image ${image}`),
        );
      return newest.id;
    });

    /** Returns the ID of the project's SSH key, network, or firewall named `name`. */
    const named = Effect.fn("HetznerDriver.named")(function* (
      resource: "ssh_keys" | "networks" | "firewalls",
      name: string,
    ) {
      const response = yield* api.send("GET", `/${resource}`, { query: { name } });
      const operation = `list ${resource}`;
      const listed =
        resource === "ssh_keys"
          ? (yield* api.decode(SshKeys, operation)(response)).ssh_keys
          : resource === "networks"
            ? (yield* api.decode(Networks, operation)(response)).networks
            : (yield* api.decode(Firewalls, operation)(response)).firewalls;
      return Option.fromNullishOr(listed[0]?.id);
    });

    const labelsOf = (tags: MachineTags) => ({
      ...settings.labels,
      [LABELS.instance]: tagValue(tags.instance),
      [LABELS.worker]: tagValue(tags.worker),
      [LABELS.run]: tagValue(tags.run),
      [LABELS.process]: tagValue(tags.process),
      [LABELS.attempt]: attemptTag(tags.attempt),
    });

    const verify = Effect.fn("HetznerDriver.verify")(
      function* (_worker: WorkerName, maxConcurrentAttempts: number) {
        yield* Effect.annotateCurrentSpan({ worker, maxConcurrentAttempts });
        const types = yield* api
          .send("GET", "/server_types", { query: { name: settings.serverType } })
          .pipe(Effect.flatMap(api.decode(ServerTypes, "list server types")));
        const serverType = types.server_types[0];
        if (serverType === undefined)
          return yield* providerGap(
            `Hetzner Cloud has no server type "${settings.serverType}" for worker "${worker}"`,
            new Error(`no server type ${settings.serverType}`),
          );
        const location = serverType.locations?.find(({ name }) => name === settings.location);
        if (serverType.locations !== undefined && location === undefined)
          return yield* providerGap(
            `Hetzner Cloud doesn't offer server type ${settings.serverType} in ${settings.location} for worker "${worker}"`,
            new Error(`no location ${settings.location} for ${settings.serverType}`),
          );
        const image = yield* imageId();
        const key = yield* named("ssh_keys", settings.sshKey);
        if (Option.isNone(key))
          return yield* providerGap(
            `The Hetzner Cloud project of worker "${worker}" has no SSH key named "${settings.sshKey}". Add the public key of identity_file with hcloud ssh-key create.`,
            new Error(`no SSH key ${settings.sshKey}`),
          );
        if (Option.isSome(settings.network)) {
          const network = yield* named("networks", settings.network.value);
          if (Option.isNone(network))
            return yield* providerGap(
              `The Hetzner Cloud project of worker "${worker}" has no network named "${settings.network.value}"`,
              new Error(`no network ${settings.network.value}`),
            );
        }
        if (Option.isSome(settings.firewall)) {
          const firewall = yield* named("firewalls", settings.firewall.value);
          if (Option.isNone(firewall))
            return yield* providerGap(
              `The Hetzner Cloud project of worker "${worker}" has no firewall named "${settings.firewall.value}"`,
              new Error(`no firewall ${settings.firewall.value}`),
            );
        }
        const warnings =
          location?.available === false
            ? [
                `Hetzner Cloud has no ${settings.serverType} available in ${settings.location} now, so machines can't be created until it has. Each attempt waits and tries again.`,
              ]
            : [];
        yield* Effect.logInfo("Hetzner Cloud provisioner verified", {
          worker,
          serverType: settings.serverType,
          location: settings.location,
          available: location?.available ?? "not reported",
          image,
          network: Option.getOrElse(settings.network, () => "none"),
          // The API documents no endpoint for the project's server limit.
          limits: "not documented",
        });
        return { warnings };
      },
      (effect) =>
        effect.pipe(
          Effect.catchTags({
            ProviderUnanswered: (failure) =>
              Effect.fail(
                providerGap(
                  `Can't reach the Hetzner Cloud API for worker "${worker}": ${failure.detail}`,
                  failure,
                ),
              ),
            ProviderRefused: (failure) =>
              Effect.fail(
                providerGap(
                  failure.status === 401
                    ? `Hetzner Cloud refused the token of worker "${worker}". Create a read and write API token for the project, and set it in provisioner.token_env.`
                    : `Hetzner Cloud refused a preflight request of worker "${worker}": ${failureText(failure)}`,
                  failure,
                ),
              ),
          }),
        ),
    );

    const create = Effect.fn("HetznerDriver.create")(
      function* (name: string, tags: MachineTags) {
        yield* Effect.annotateCurrentSpan({ worker, name, run: tags.run });
        const image = yield* imageId().pipe(
          Effect.catchTag("WorkerCapabilityError", (gap) =>
            Effect.fail(
              new MachineUnavailableError({
                worker,
                provider: "hetzner",
                reason: "refused",
                message: gap.message,
              }),
            ),
          ),
        );
        const key = yield* named("ssh_keys", settings.sshKey);
        const network = Option.isSome(settings.network)
          ? yield* named("networks", settings.network.value)
          : Option.none<number>();
        const firewall = Option.isSome(settings.firewall)
          ? yield* named("firewalls", settings.firewall.value)
          : Option.none<number>();
        const hostKey = yield* generateHostKey;
        const response = yield* api.send("POST", "/servers", {
          body: {
            name,
            server_type: settings.serverType,
            location: settings.location,
            image: String(image),
            ssh_keys: Option.match(key, {
              onNone: () => [settings.sshKey],
              onSome: (id) => [String(id)],
            }),
            networks: Option.match(network, { onNone: () => [], onSome: (id) => [id] }),
            firewalls: Option.match(firewall, {
              onNone: () => [],
              onSome: (id) => [{ firewall: id }],
            }),
            public_net: { enable_ipv4: !privateOnly, enable_ipv6: false },
            labels: labelsOf(tags),
            user_data: hostKeyUserData(hostKey),
            start_after_create: true,
          },
        });
        const created = yield* api.decode(Created, "create a server")(response);
        return {
          id: MachineId.make(String(created.server.id)),
          hostKey: Option.some(hostKey.publicKey),
        };
      },
      (effect, _name, _tags) =>
        effect.pipe(
          Effect.catchTags({
            ProviderUnanswered: (failure) =>
              Effect.fail(
                new MachineUnavailableError({
                  worker,
                  provider: "hetzner",
                  reason: "unreachable",
                  message: `Can't reach the Hetzner Cloud API to create a server: ${failure.detail}`,
                }),
              ),
            ProviderRefused: (failure) =>
              Effect.fail(
                new MachineUnavailableError({
                  worker,
                  provider: "hetzner",
                  reason: creationReason(failure),
                  message: `Hetzner Cloud didn't create a ${settings.serverType} server in ${settings.location}: ${failureText(failure)}`,
                }),
              ),
          }),
        ),
    );

    /** Returns the address to connect to: the private one behind a Gateway, else the public IPv4. */
    const addressOf = (server: typeof Server.Type): Option.Option<string> =>
      Option.fromNullishOr(privateOnly ? server.private_net?.[0]?.ip : server.public_net?.ipv4?.ip);

    const endpoint = Effect.fn("HetznerDriver.endpoint")(
      function* (id: MachineId, interval: Effect.Effect<void>) {
        yield* Effect.annotateCurrentSpan({ worker, machine: id });
        while (true) {
          const server = (yield* api
            .send("GET", `/servers/${id}`)
            .pipe(Effect.flatMap(api.decode(OneServer, "read the server")))).server;
          const address = addressOf(server);
          if (server.status === "running" && Option.isSome(address))
            return {
              destination: SshDestination.make(`${settings.sshUser}@${address.value}`),
              port: Option.none(),
              hostKey: Option.none(),
            };
          yield* Effect.logDebug("Waiting for the Hetzner Cloud server to run", {
            worker,
            machine: id,
            status: server.status,
          });
          yield* interval;
        }
      },
      (effect) =>
        effect.pipe(
          Effect.catchTags({
            ProviderUnanswered: (failure) =>
              Effect.fail(
                new MachineUnavailableError({
                  worker,
                  provider: "hetzner",
                  reason: "unreachable",
                  message: `Can't reach the Hetzner Cloud API to read a new server: ${failure.detail}`,
                }),
              ),
            ProviderRefused: (failure) =>
              Effect.fail(
                new MachineUnavailableError({
                  worker,
                  provider: "hetzner",
                  reason: failure.status === 404 ? "capacity" : creationReason(failure),
                  message:
                    failure.status === 404
                      ? "Hetzner Cloud removed the new server before it ran"
                      : `Hetzner Cloud couldn't read the new server: ${failureText(failure)}`,
                }),
              ),
          }),
        ),
    );

    const remove = Effect.fn("HetznerDriver.remove")(function* (id: MachineId) {
      yield* Effect.annotateCurrentSpan({ worker, machine: id });
      yield* api.send("DELETE", `/servers/${id}`).pipe(
        Effect.asVoid,
        Effect.catchIf(
          (failure) => failure._tag === "ProviderRefused" && failure.status === 404,
          () => Effect.void,
        ),
        Effect.mapError(apiError("delete the server")),
      );
    });

    const list = Effect.fn("HetznerDriver.list")(function* (instance: string, listed: WorkerName) {
      yield* Effect.annotateCurrentSpan({ worker: listed });
      const pages = yield* listAll(
        "/servers",
        {
          label_selector: `${LABELS.instance}=${tagValue(instance)},${LABELS.worker}=${tagValue(listed)}`,
        },
        Servers,
        "list servers",
      ).pipe(Effect.mapError(apiError("list the servers")));
      return pages
        .flatMap(({ servers }) => servers)
        .map((server): ListedMachine => ({
          id: MachineId.make(String(server.id)),
          tags: {
            worker: server.labels[LABELS.worker] ?? "",
            run: server.labels[LABELS.run] ?? "",
            process: server.labels[LABELS.process] ?? "",
            attempt: Option.fromNullishOr(server.labels[LABELS.attempt]),
          },
          createdAt: Option.getOrElse(DateTime.make(server.created), () => DateTime.makeUnsafe(0)),
        }));
    });

    return {
      provider: "hetzner",
      verify,
      create,
      endpoint,
      remove,
      list,
    } satisfies MachineDriver;
  });

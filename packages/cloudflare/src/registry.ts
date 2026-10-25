import type { WorkerName } from "@usine/core/worker";
import { Context, Effect, Layer, Option } from "effect";
import { HttpServer } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import { registryGroup, type SandboxName, SandboxList, type SandboxSummary } from "./api/api.ts";

/** The registry Durable Object's storage: the last summary each sandbox recorded, by name. */
export class RegistryStorage extends Context.Service<
  RegistryStorage,
  {
    readonly list: Effect.Effect<ReadonlyArray<SandboxSummary>>;
    readonly put: (sandbox: SandboxSummary) => Effect.Effect<void>;
    readonly remove: (name: SandboxName) => Effect.Effect<void>;
  }
>()("@usine/cloudflare/RegistryStorage") {}

/** Reads a sandbox's current summary from its own Durable Object. */
export class SandboxLookup extends Context.Service<
  SandboxLookup,
  {
    /** Returns `None` if the sandbox no longer exists. */
    readonly get: (name: SandboxName) => Effect.Effect<Option.Option<SandboxSummary>>;
  }
>()("@usine/cloudflare/SandboxLookup") {}

/** The number of sandboxes whose summary a listing reads at once. */
const LOOKUP_CONCURRENCY = 8;

/**
 * Returns the sandboxes of `owner`, each as its Durable Object reports it now. Forgets entries
 * whose sandbox no longer exists, such as one whose destroy couldn't reach the registry.
 */
const list = Effect.fn("SandboxRegistry.list")(function* (owner: WorkerName) {
  yield* Effect.annotateCurrentSpan({ owner });
  const storage = yield* RegistryStorage;
  const lookup = yield* SandboxLookup;
  const recorded = (yield* storage.list).filter((sandbox) => sandbox.owner === owner);
  const current = yield* Effect.forEach(
    recorded,
    (sandbox) =>
      lookup.get(sandbox.name).pipe(
        Effect.tap((found) =>
          Option.isNone(found)
            ? storage.remove(sandbox.name).pipe(
                Effect.andThen(
                  Effect.logInfo("Forgot a sandbox that no longer exists", {
                    sandbox: sandbox.name,
                    owner,
                  }),
                ),
              )
            : Effect.void,
        ),
      ),
    { concurrency: LOOKUP_CONCURRENCY },
  );
  const sandboxes = current.flatMap(Option.toArray);
  yield* Effect.logInfo("Listed the Worker's sandboxes", {
    owner,
    sandboxes: sandboxes.length,
    running: sandboxes.filter(({ running }) => running).length,
  });
  return new SandboxList({ sandboxes });
});

const RegistryServedApi = HttpApi.make("SandboxApi").add(registryGroup);

const registryHandlers = HttpApiBuilder.group(RegistryServedApi, "registry", (routes) =>
  routes.handle("list", ({ query }) => list(query.owner)),
);

/** The registry route of `SandboxApi`. Requires `RegistryStorage` and `SandboxLookup`. */
export const registryRoutes = HttpApiBuilder.layer(RegistryServedApi).pipe(
  Layer.provide(registryHandlers),
  Layer.provide(HttpServer.layerServices),
);

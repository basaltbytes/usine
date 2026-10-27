import { Context, Effect, Layer, Option, Schema } from "effect";
import { HttpServer } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import {
  registryGroup,
  SandboxName,
  SandboxList,
  type SandboxOwner,
  type SandboxSummary,
} from "./api/api.ts";

/** The registry Durable Object's storage: the last summary each sandbox recorded, by name. */
export class RegistryStorage extends Context.Service<
  RegistryStorage,
  {
    readonly list: Effect.Effect<ReadonlyArray<SandboxSummary>>;
    readonly put: (sandbox: SandboxSummary) => Effect.Effect<void>;
    readonly remove: (name: SandboxName) => Effect.Effect<void>;
  }
>()("@usine/cloudflare/RegistryStorage") {}

/** A sandbox's Durable Object didn't answer with its summary or a 404. */
export class SandboxLookupFailed extends Schema.TaggedError<SandboxLookupFailed>()(
  "SandboxLookupFailed",
  { name: SandboxName, reason: Schema.String },
) {}

/** Reads a sandbox's current summary from its own Durable Object. */
export class SandboxLookup extends Context.Service<
  SandboxLookup,
  {
    /** Returns `None` only if the sandbox's Durable Object answers that it doesn't exist. */
    readonly get: (
      name: SandboxName,
    ) => Effect.Effect<Option.Option<SandboxSummary>, SandboxLookupFailed>;
  }
>()("@usine/cloudflare/SandboxLookup") {}

/** The number of sandboxes whose summary a listing reads at once. */
const LOOKUP_CONCURRENCY = 8;

/**
 * Returns the sandboxes of `owner`, each as its Durable Object reports it now. Forgets entries
 * whose sandbox no longer exists, such as one whose destroy couldn't reach the registry. A sandbox
 * whose Durable Object doesn't answer keeps its entry and is left out of this listing, so nothing
 * destroys it until a listing can read it.
 */
const list = Effect.fn("SandboxRegistry.list")(function* (owner: SandboxOwner) {
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
        Effect.catchTag("SandboxLookupFailed", (failure) =>
          Effect.logWarning(
            "Could not read a sandbox's state; kept its registration and left it out of the listing",
            { sandbox: sandbox.name, owner, reason: failure.reason },
          ).pipe(Effect.as(Option.none<SandboxSummary>())),
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

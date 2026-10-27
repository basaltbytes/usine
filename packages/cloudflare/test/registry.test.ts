import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Option, Schema } from "effect";
import { HttpRouter } from "effect/http";
import { SandboxName, SandboxOwner, SandboxSummary } from "../src/api/api.ts";
import {
  registryRoutes,
  RegistryStorage,
  SandboxLookup,
  SandboxLookupFailed,
} from "../src/registry.ts";
import { ATTEMPT, IMAGE, OWNER } from "./support.ts";

const summary = (name: string, owner: SandboxOwner, running: boolean) =>
  new SandboxSummary({
    name: SandboxName.make(name),
    owner,
    attempt: ATTEMPT,
    image: IMAGE,
    instanceType: "standard-4",
    createdAt: DateTime.makeUnsafe(0),
    running,
    held: false,
    draining: false,
  });

describe("sandbox registry", () => {
  it("lists the owner's sandboxes as they are now and forgets those that are gone", async () => {
    // Another instance's Worker with the same name.
    const other = SandboxOwner.make("github-app-2.cf-one");
    const recorded = new Map(
      [
        summary("github-app-1.cf-one.alive", OWNER, true),
        summary("github-app-1.cf-one.stopped", OWNER, true),
        summary("github-app-1.cf-one.gone", OWNER, true),
        summary("github-app-2.cf-one.alive", other, true),
      ].map((sandbox) => [sandbox.name, sandbox]),
    );
    const current = new Map([
      ["github-app-1.cf-one.alive", summary("github-app-1.cf-one.alive", OWNER, true)],
      ["github-app-1.cf-one.stopped", summary("github-app-1.cf-one.stopped", OWNER, false)],
    ]);
    const services = Layer.mergeAll(
      Layer.succeed(RegistryStorage)({
        list: Effect.sync(() => [...recorded.values()]),
        put: (sandbox) => Effect.sync(() => void recorded.set(sandbox.name, sandbox)),
        remove: (name) => Effect.sync(() => void recorded.delete(name)),
      }),
      Layer.succeed(SandboxLookup)({
        get: (name) => Effect.sync(() => Option.fromNullishOr(current.get(name))),
      }),
    );
    const web = HttpRouter.toWebHandler(registryRoutes.pipe(HttpRouter.provideRequest(services)), {
      disableLogger: true,
    });

    const response = await web.handler(
      new Request(`https://sandboxes.test/v1/sandboxes?owner=${OWNER}`),
    );
    const list = Schema.decodeUnknownSync(
      Schema.toCodecJson(Schema.Struct({ sandboxes: Schema.Array(SandboxSummary) })),
    )(await response.json());

    expect(list.sandboxes.map(({ name, running }) => [name, running])).toEqual([
      ["github-app-1.cf-one.alive", true],
      ["github-app-1.cf-one.stopped", false],
    ]);
    expect([...recorded.keys()]).toEqual([
      "github-app-1.cf-one.alive",
      "github-app-1.cf-one.stopped",
      "github-app-2.cf-one.alive",
    ]);
  });

  it("keeps the registration of a sandbox whose state it can't read", async () => {
    const unreadable = summary("github-app-1.cf-one.unreadable", OWNER, true);
    const recorded = new Map([[unreadable.name, unreadable]]);
    const services = Layer.mergeAll(
      Layer.succeed(RegistryStorage)({
        list: Effect.sync(() => [...recorded.values()]),
        put: (sandbox) => Effect.sync(() => void recorded.set(sandbox.name, sandbox)),
        remove: (name) => Effect.sync(() => void recorded.delete(name)),
      }),
      Layer.succeed(SandboxLookup)({
        get: (name) => Effect.fail(new SandboxLookupFailed({ name, reason: "status 500" })),
      }),
    );
    const web = HttpRouter.toWebHandler(registryRoutes.pipe(HttpRouter.provideRequest(services)), {
      disableLogger: true,
    });

    const response = await web.handler(
      new Request(`https://sandboxes.test/v1/sandboxes?owner=${OWNER}`),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sandboxes: [] });
    expect([...recorded.keys()]).toEqual(["github-app-1.cf-one.unreadable"]);
  });
});

import { administratorPermissions } from "@usine/core/access";
import { InstanceDirectory } from "@usine/core/instance";
import { type ProviderLoginView } from "@usine/gateway/credentials";
import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Context, DateTime, Effect, FileSystem, Layer, Option, Redacted } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import { Port, ProviderCommand } from "../src/cli.ts";
import {
  InstanceLaunch,
  InstanceRecord,
  ProcessId,
  instanceFiles,
  writeRecord,
} from "../src/instance/record.ts";
import { providerCommand } from "../src/providers/cli.ts";
import { ProviderLogins } from "../src/providers/control.ts";
import { providerRoutes } from "../src/providers/http.ts";
import { authenticatedRoutes } from "../src/auth/http.ts";
import { authFixture, alice, localSecret } from "./auth/fixture.ts";

it.live("logs in and out through the authenticated provider API using FetchHttpClient", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const folder = yield* fs.makeTempDirectoryScoped();
      const directory = InstanceDirectory.make(folder);
      const files = instanceFiles(directory);
      yield* fs.makeDirectory(files.folder);
      yield* fs.writeFileString(`${files.folder}/admin-token`, localSecret, { mode: 0o600 });
      const services = yield* authFixture();
      const connected = new Set<string>();
      let logins: readonly ProviderLoginView[] = [];
      const server = yield* Layer.build(
        HttpRouter.serve(
          providerRoutes.pipe(
            Layer.provide(authenticatedRoutes(services).guard.layer),
            HttpRouter.provideRequest(
              Layer.succeed(ProviderLogins, {
                status: Effect.sync(() => ({
                  targets: [{ target: "local", label: "Local harnesses", providers: [] }],
                  logins,
                })),
                begin: (target, provider) =>
                  Effect.sync(() => {
                    const login: ProviderLoginView = {
                      id: `login-${provider}`,
                      target,
                      provider,
                      state: { status: "connected" },
                    };
                    connected.add(`${target}/${provider}`);
                    logins = [login];
                    return login;
                  }),
                disconnect: (target, provider) =>
                  Effect.sync(() => {
                    connected.delete(`${target}/${provider}`);
                  }),
                submit: () => Effect.die("unexpected code submission"),
                cancel: () => Effect.die("unexpected cancellation"),
                apiKey: () => Effect.die("unexpected API key"),
              }),
            ),
          ),
        ).pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
      );
      const address = Context.get(server, HttpServer.HttpServer).address;
      assert(address._tag !== "UnixPathAddress");
      yield* writeRecord(
        files,
        InstanceRecord.make({
          pid: ProcessId.make(process.pid),
          version: "1.0.0",
          startedAt: DateTime.nowUnsafe(),
          launch: InstanceLaunch.make({
            node: process.execPath,
            nodeOptions: [],
            script: "/usine/main.js",
            port: Port.make(address.port),
            logLevel: "Info",
            allowVolatileInstance: false,
          }),
        }),
      );
      for (const provider of ["claude", "chatgpt"] as const) {
        const command = {
          provider,
          mode: "subscription" as const,
          target: Option.none<string>(),
        };
        yield* providerCommand(directory, ProviderCommand.make({ ...command, action: "login" }));
        assert.isTrue(connected.has(`local/${provider}`));
        yield* providerCommand(directory, ProviderCommand.make({ ...command, action: "logout" }));
        assert.isFalse(connected.has(`local/${provider}`));
      }
    }),
  ).pipe(Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
);

it.live("requires admin access and CSRF for provider credentials and allows setup sessions", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let granted = false;
      const services = yield* authFixture([alice], alice, () =>
        granted ? administratorPermissions : [],
      );
      const { guard } = authenticatedRoutes(services);
      const app = HttpRouter.toWebHandler(
        providerRoutes.pipe(
          Layer.provide(guard.layer),
          HttpRouter.provideRequest(
            Layer.succeed(ProviderLogins, {
              status: Effect.succeed({ targets: [], logins: [] }),
              begin: () => Effect.die("unused begin"),
              submit: () => Effect.void,
              cancel: () => Effect.void,
              apiKey: () => Effect.void,
              disconnect: () => Effect.void,
            }),
          ),
        ),
        { disableLogger: true },
      );
      yield* Effect.addFinalizer(() => Effect.promise(() => app.dispose()));
      const request = (headers: Record<string, string>, path = "/api/providers", method = "GET") =>
        Effect.promise(() => {
          const options: RequestInit = { method, headers };
          if (method !== "GET")
            options.body = '{"target":"local","provider":"claude","key":"private-key"}';
          return app.handler(new Request(`https://usine.example${path}`, options));
        });
      assert.equal((yield* request({})).status, 401);
      const web = yield* services.authentication.startWeb(false);
      const member = yield* services.authentication.finishWeb(Redacted.value(web.state), "fake");
      assert.equal(
        (yield* request({ authorization: `Bearer ${Redacted.value(member.secret)}` })).status,
        403,
      );
      assert.equal((yield* request({ authorization: `Bearer ${localSecret}` })).status, 200);
      granted = true;
      const link = yield* services.authentication.link;
      const session = yield* services.authentication.consumeLink(
        new URLSearchParams(new URL(link).hash.slice(1)).get("link") ?? "",
      );
      const cookie = `usine_session=${Redacted.value(session.secret)}`;
      assert.equal((yield* request({ cookie }, "/api/providers/key", "PUT")).status, 403);
      assert.equal(
        (yield* request(
          { cookie, "x-usine-csrf": session.csrf, "content-type": "application/json" },
          "/api/providers/key",
          "PUT",
        )).status,
        200,
      );
      const setup = yield* authFixture([]);
      const setupLink = yield* setup.authentication.link;
      const bootstrap = yield* setup.authentication.consumeLink(
        new URLSearchParams(new URL(setupLink).hash.slice(1)).get("link") ?? "",
      );
      const setupApp = HttpRouter.toWebHandler(
        providerRoutes.pipe(
          Layer.provide(authenticatedRoutes(setup).guard.layer),
          HttpRouter.provideRequest(
            Layer.succeed(ProviderLogins, {
              status: Effect.succeed({ targets: [], logins: [] }),
              begin: () => Effect.die("unused"),
              submit: () => Effect.void,
              cancel: () => Effect.void,
              apiKey: () => Effect.void,
              disconnect: () => Effect.void,
            }),
          ),
        ),
        { disableLogger: true },
      );
      yield* Effect.addFinalizer(() => Effect.promise(() => setupApp.dispose()));
      const response = yield* Effect.promise(() =>
        setupApp.handler(
          new Request("https://usine.example/api/providers", {
            headers: { authorization: `Bearer ${Redacted.value(bootstrap.secret)}` },
          }),
        ),
      );
      assert.equal(response.status, 200);
    }),
  ),
);

// The CLI case types an API key on a stand-in terminal, which only the unstable Terminal API builds.
// @effect-diagnostics unstableApiUsage:off
import { administratorPermissions } from "@usine/core/access";
import { InstanceDirectory } from "@usine/core/instance";
import {
  anthropic,
  ApiKeyCredential,
  GatewaySlot,
  GatewayVariable,
  HeaderName,
  KeyHeader,
  ModelProvider,
  ModelProviderId,
  openai,
  ProviderProtocol,
  RoutePattern,
  UpstreamBase,
  WireProtocol,
} from "@usine/core/agent/provider";
import {
  providerEntry,
  type ProviderLoginView,
  type ProviderTarget,
} from "@usine/gateway/credentials";
import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import {
  type Cause,
  Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Queue,
  Redacted,
  Terminal,
} from "effect";
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

/** A terminal on which the operator types `text`, then presses Enter. */
const typing = (text: string) =>
  Terminal.make({
    columns: Effect.succeed(80),
    rows: Effect.succeed(24),
    readInput: Effect.gen(function* () {
      const input = yield* Queue.make<Terminal.UserInput, Cause.Done>();
      const key = (name: string) => ({ name, ctrl: false, meta: false, shift: false });
      yield* Queue.offerAll(input, [
        ...[...text].map((character) => ({ input: Option.some(character), key: key(character) })),
        { input: Option.none(), key: key("enter") },
      ]);
      return input;
    }),
    readLine: Effect.succeed(text),
    display: () => Effect.void,
  });

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
      const plan = ModelProvider.make({
        id: ModelProviderId.make("test-plan"),
        slot: GatewaySlot.make("test-plan"),
        label: "Test plan",
        protocols: [
          ProviderProtocol.make({
            protocol: WireProtocol.make("openai-chat-completions"),
            upstream: UpstreamBase.make("https://plan.test/v1"),
            routes: [RoutePattern.make("/chat/completions")],
            key: KeyHeader.make({ header: HeaderName.make("authorization"), scheme: "bearer" }),
          }),
        ],
        credentials: [
          ApiKeyCredential.make({ variable: GatewayVariable.make("TEST_PLAN_API_KEY") }),
        ],
      });
      const connections = [anthropic, openai, plan].map((provider) => ({
        provider: provider.slot,
        ...providerEntry(provider),
        credential: null,
        expiresAt: null,
        lastRefresh: null,
      }));
      let providers: ReadonlyArray<ProviderTarget["providers"][number]> = connections;
      const calls: string[] = [];
      let logins: readonly ProviderLoginView[] = [];
      const server = yield* Layer.build(
        HttpRouter.serve(
          providerRoutes.pipe(
            Layer.provide(authenticatedRoutes(services).guard.layer),
            HttpRouter.provideRequest(
              Layer.succeed(ProviderLogins, {
                status: Effect.sync(() => ({
                  targets: [{ target: "local", label: "Local harnesses", providers }],
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
                    calls.push(`begin ${target}/${provider}`);
                    logins = [login];
                    return login;
                  }),
                disconnect: (target, provider) =>
                  Effect.sync(() => {
                    calls.push(`disconnect ${target}/${provider}`);
                  }),
                submit: () => Effect.die("unexpected code submission"),
                cancel: () => Effect.die("unexpected cancellation"),
                apiKey: (target, provider, key) =>
                  Effect.sync(() => {
                    calls.push(`key ${target}/${provider} ${Redacted.value(key)}`);
                  }),
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
      const command = (
        provider: string,
        action: "login" | "logout",
        mode: "subscription" | "api-key" = "subscription",
      ) =>
        providerCommand(
          directory,
          ProviderCommand.make({ provider, action, mode, target: Option.none() }),
        );
      for (const provider of ["claude", "openai"]) {
        yield* command(provider, "login");
        yield* command(provider, "logout");
      }
      assert.deepStrictEqual(calls, [
        "begin local/claude",
        "disconnect local/anthropic-messages",
        "begin local/chatgpt",
        "disconnect local/openai-responses",
      ]);
      const unknown = yield* command("unknown-plan", "login").pipe(Effect.flip);
      assert.strictEqual(
        unknown.message,
        "Local harnesses has no provider unknown-plan. Choose anthropic or claude (Anthropic: a subscription, or an API key with --api-key); openai or chatgpt (OpenAI: a subscription, or an API key with --api-key); test-plan (Test plan: an API key with --api-key).",
      );
      const keyOnly = yield* command("test-plan", "login").pipe(Effect.flip);
      assert.strictEqual(
        keyOnly.message,
        "Test plan takes an API key. Run usine login test-plan --api-key.",
      );

      // The local Codex auth file is unreadable: a key or a logout replaces it, and a sign-in waits.
      const error = "Could not read the Codex auth file.";
      providers = connections.map((connection) =>
        connection.provider === openai.slot
          ? {
              provider: connection.provider,
              id: connection.id,
              label: connection.label,
              accepts: connection.accepts,
              error,
            }
          : connection,
      );
      calls.length = 0;
      yield* command("openai", "login", "api-key").pipe(
        Effect.provideService(Terminal.Terminal, typing("sk-proj-replacement")),
      );
      yield* command("openai", "logout");
      const signIn = yield* command("openai", "login").pipe(Effect.flip);
      assert.deepStrictEqual(calls, [
        "key local/openai-responses sk-proj-replacement",
        "disconnect local/openai-responses",
      ]);
      assert.strictEqual(signIn.message, `Local harnesses: ${error}`);
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

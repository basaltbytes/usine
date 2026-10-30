import { NodeHttpPlatform, NodeHttpServer } from "@effect/platform-node";
import { UiOrigin } from "@usine/config/factory";
import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { assert, it } from "vitest";
import { authenticatedRoutes } from "../src/auth/http.ts";
import { staticRoutes } from "../src/http.ts";
import { securityMiddleware } from "../src/security.ts";
import { authFixture, localSecret } from "./auth/fixture.ts";

it("enforces exact origins before credentialed handlers and sets security headers on routes, assets, and errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "usine-security-"));
  try {
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "index.html"), "<main>usine</main>");
    await writeFile(join(root, "assets/app.css"), "body { color: black; }");
    await Effect.runPromise(
      Effect.gen(function* () {
        const services = yield* authFixture();
        const { routes } = authenticatedRoutes(services);
        const app = HttpRouter.toWebHandler(
          Layer.mergeAll(
            routes,
            staticRoutes(root),
            HttpRouter.add("POST", "/webhooks/github", HttpServerResponse.empty({ status: 401 })),
            HttpRouter.add("GET", "/defect", Effect.die("test defect")),
            securityMiddleware(services.authentication),
          ).pipe(HttpRouter.provideRequest(NodeHttpPlatform.layer)),
          { disableLogger: true },
        );
        yield* Effect.addFinalizer(() => Effect.promise(() => app.dispose()));
        const link = yield* services.authentication.link;
        const local = yield* services.authentication.authenticate(localSecret);
        yield* Effect.promise(async () => {
          const request = (path: string, options?: RequestInit) =>
            app.handler(new Request(`https://usine.example${path}`, options));
          for (const [path, method, status] of [
            ["/api/health", "GET", 200],
            ["/api/auth/info", "GET", 200],
            ["/api/auth/session", "GET", 401],
            ["/api/auth/github", "GET", 302],
            ["/api/auth/device", "POST", 400],
            ["/webhooks/github", "POST", 401],
            ["/", "GET", 200],
            ["/assets/app.css", "GET", 200],
            ["/assets/missing.js", "GET", 404],
            ["/missing", "POST", 404],
            ["/defect", "GET", 500],
          ] as const) {
            const response = await request(path, { method });
            assert.equal(response.status, status, path);
            assert.equal(response.headers.get("x-content-type-options"), "nosniff", path);
            assert.equal(response.headers.get("referrer-policy"), "no-referrer", path);
            assert.equal(
              response.headers.get("permissions-policy"),
              "camera=(), microphone=(), geolocation=()",
              path,
            );
            assert.equal(response.headers.get("x-frame-options"), "DENY", path);
            assert.equal(
              response.headers.get("strict-transport-security"),
              "max-age=31536000",
              path,
            );
            assert.include(
              response.headers.get("content-security-policy") ?? "",
              "script-src 'self'",
              path,
            );
            assert.isNull(response.headers.get("access-control-allow-origin"));
          }
          for (const origin of services.authentication.origins) {
            const response = await request("/api/auth/session", {
              headers: { origin, authorization: `Bearer ${localSecret}` },
            });
            assert.equal(response.status, 200);
            assert.equal(response.headers.get("access-control-allow-origin"), origin);
            assert.equal(response.headers.get("access-control-allow-credentials"), "true");
            assert.include(response.headers.get("vary") ?? "", "Origin");
            const denied = await request("/api/auth/session", { headers: { origin } });
            assert.equal(denied.status, 401);
            assert.equal(denied.headers.get("access-control-allow-origin"), origin);
          }
          const token = new URLSearchParams(new URL(link).hash.slice(1)).get("link");
          for (const origin of [
            "https://evil.example",
            "null",
            "https://usine.example:8443",
            "https://usine.example/",
            "http://localhost:5173",
          ]) {
            for (const options of [
              { method: "GET", headers: { authorization: `Bearer ${localSecret}` } },
              {
                method: "POST",
                headers: { cookie: `usine_session=${localSecret}`, "x-usine-csrf": local.csrf },
              },
              { method: "OPTIONS", headers: { "access-control-request-method": "POST" } },
            ]) {
              const response = await request(
                options.method === "GET" ? "/api/auth/session" : "/api/auth/sign-out",
                { ...options, headers: { ...options.headers, origin } },
              );
              assert.equal(response.status, 403, origin);
              assert.isFalse(
                [...response.headers.keys()].some((name) => name.startsWith("access-control-")),
              );
            }
            const consumed = await request("/api/auth/link/consume", {
              method: "POST",
              headers: { origin, "content-type": "application/json" },
              body: JSON.stringify({ token }),
            });
            assert.equal(consumed.status, 403);
          }
          assert.equal(
            (
              await request("/api/auth/link/consume", {
                method: "POST",
                headers: { origin: "https://client.example", "content-type": "application/json" },
                body: JSON.stringify({ token }),
              })
            ).status,
            200,
          );
          for (const method of ["GET", "POST", "PUT", "DELETE"]) {
            const preflight = await request("/api/auth/session", {
              method: "OPTIONS",
              headers: {
                origin: "https://client.example",
                "access-control-request-method": method,
                "access-control-request-headers": "Authorization, Content-Type, X-Usine-CSRF",
              },
            });
            assert.equal(preflight.status, 204);
            assert.equal(
              preflight.headers.get("access-control-allow-origin"),
              "https://client.example",
            );
            assert.equal(
              preflight.headers.get("access-control-allow-methods"),
              "GET, POST, PUT, DELETE",
            );
            assert.equal(
              preflight.headers.get("access-control-allow-headers"),
              "authorization, content-type, x-usine-csrf",
            );
            assert.equal(preflight.headers.get("x-frame-options"), "DENY");
          }
          for (const headers of [
            { "access-control-request-method": "PATCH" },
            {
              "access-control-request-method": "POST",
              "access-control-request-headers": "X-Unknown",
            },
          ]) {
            const response = await request("/api/auth/session", {
              method: "OPTIONS",
              headers: { ...headers, origin: "https://client.example" },
            });
            assert.equal(response.status, 403);
            assert.isNull(response.headers.get("access-control-allow-methods"));
          }
        });
      }).pipe(Effect.scoped),
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

it("does not trust forwarded headers or a caller origin to enable HSTS on local HTTP", async () => {
  const origin = UiOrigin.make("http://127.0.0.1:7331");
  const app = HttpRouter.toWebHandler(
    Layer.merge(
      HttpRouter.add("GET", "/", HttpServerResponse.empty()),
      securityMiddleware({ origin, origins: [origin, UiOrigin.make("https://client.example")] }),
    ),
    { disableLogger: true },
  );
  try {
    const response = await app.handler(
      new Request(`${origin}/`, {
        headers: { origin: "https://client.example", "x-forwarded-proto": "https" },
      }),
    );
    assert.isNull(response.headers.get("strict-transport-security"));
  } finally {
    await app.dispose();
  }
});

it("loads the bundled sign-in UI under the production CSP without browser errors", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const services = yield* authFixture();
      const context = yield* Layer.build(NodeHttpServer.layerTest);
      const server = Context.get(context, HttpServer.HttpServer);
      assert.notEqual(server.address._tag, "UnixPathAddress");
      if (server.address._tag === "UnixPathAddress") return;
      const url = UiOrigin.make(`http://127.0.0.1:${server.address.port}`);
      yield* Layer.build(
        HttpRouter.serve(
          Layer.mergeAll(
            authenticatedRoutes(services).routes,
            staticRoutes(fileURLToPath(new URL("../../web/dist", import.meta.url))),
            securityMiddleware({ origin: url, origins: [url] }),
          ),
        ).pipe(Layer.provide(Layer.succeedContext(context))),
      );
      const browser = yield* Effect.acquireRelease(
        Effect.promise(() =>
          chromium.launch(
            process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH === undefined
              ? {}
              : { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
          ),
        ),
        (browser) => Effect.promise(() => browser.close()),
      );
      yield* Effect.promise(async () => {
        const page = await browser.newPage();
        const errors: Array<string> = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
        });
        const response = await page.goto(`${url}/sign-in`);
        assert.include(response?.headers()["content-security-policy"] ?? "", "script-src 'self'");
        try {
          await page
            .getByRole("heading", { name: "Sign in to usine" })
            .waitFor({ timeout: 10_000 });
          await page
            .getByRole("link", { name: "Continue with GitHub" })
            .waitFor({ timeout: 10_000 });
          await page.evaluate(() => document.fonts.ready);
        } finally {
          assert.deepEqual(errors, []);
        }
      });
    }).pipe(Effect.scoped),
  );
}, 30_000);

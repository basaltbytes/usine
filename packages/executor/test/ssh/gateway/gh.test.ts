import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { assert, it } from "@effect/vitest";
import { GatewayDomain } from "@usine/core/worker";
import { Redacted } from "effect";
import { gatewayEnvironment, ghGatewayConfig } from "../../../src/ssh/gateway/environment.ts";

const run = promisify(execFile);
const ghOnPath = spawnSync("gh", ["--version"]).error === undefined;

it("authenticates gh pagination and GitHub URLs through the Gateway socket", async (context) => {
  context.skip(
    !ghOnPath,
    "gh is not on PATH; this test runs the real gh binary, version 2.83.2 or later",
  );
  // A short socket path also fits macOS's Unix socket limit. No real credentials
  // or external requests: the socket serves synthetic GitHub responses only.
  const directory = await mkdtemp("/tmp/usine-gh-");
  const socket = join(directory, "http.sock");
  const caller = "ugw1.test-claims.test-signature";
  const requests: Array<{ host: string | undefined; path: string | undefined }> = [];
  const server = createServer((request, response) => {
    requests.push({ host: request.headers.host, path: request.url });
    response.setHeader("Content-Type", "application/json");
    if (request.headers.authorization !== `token ${caller}`) {
      response.writeHead(401);
      response.end(JSON.stringify({ message: "missing-caller-token" }));
      return;
    }
    if (request.url === "/api/v3/repos/owner/repo/issues?per_page=1") {
      response.setHeader(
        "Link",
        '<https://api.github.com/repos/owner/repo/issues?per_page=1&page=2>; rel="next"',
      );
      response.end(JSON.stringify([{ number: 1 }]));
    } else if (request.url?.includes("page=2")) {
      response.end(JSON.stringify([{ number: 2 }]));
    } else {
      response.end(
        JSON.stringify({
          data: { repository: { issue: { title: "issues" }, pullRequest: { title: "pull" } } },
        }),
      );
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    const domain = GatewayDomain.make("gw.test");
    for (const [name, content] of Object.entries(ghGatewayConfig(domain)))
      await writeFile(
        join(directory, name),
        content.replace("/run/usine-gateway/http.sock", socket),
      );
    const { exported, sent } = gatewayEnvironment({
      domain,
      llmProviders: [],
      ghConfigDirectory: directory,
      callerToken: Redacted.make(caller),
    });
    const env = {
      PATH: process.env.PATH,
      HOME: directory,
      GH_NO_UPDATE_NOTIFIER: "1",
      ...exported,
      ...Object.fromEntries(
        Object.entries(sent).map(([name, value]) => [name, Redacted.value(value)]),
      ),
    };
    const options = { env, timeout: 10_000 };
    const paginated = await run(
      "gh",
      ["api", "repos/owner/repo/issues?per_page=1", "--paginate", "--jq", ".[].number"],
      options,
    );
    assert.strictEqual(paginated.stdout, "1\n2\n");
    for (const [command, kind, number] of [
      ["issue", "issues", "1"],
      ["pr", "pull", "2"],
    ] as const) {
      const result = await run(
        "gh",
        [
          command,
          "view",
          `https://github.com/owner/repo/${kind}/${number}`,
          "--json",
          "title",
          "--jq",
          ".title",
        ],
        options,
      );
      assert.strictEqual(result.stdout.trim(), kind);
    }
    assert.deepStrictEqual(requests, [
      { host: "git.gw.test", path: "/api/v3/repos/owner/repo/issues?per_page=1" },
      { host: "api.github.com", path: "/repos/owner/repo/issues?per_page=1&page=2" },
      { host: "api.github.com", path: "/graphql" },
      { host: "api.github.com", path: "/graphql" },
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

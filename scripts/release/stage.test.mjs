import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);

test("pnpm stages only unpublished workspace versions and skips approved versions on retry", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "usine-stage-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { packageManager } = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url)),
  );
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name: "stage-test", private: true, packageManager }),
  );
  await writeFile(join(directory, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
  const packages = [
    { name: "@usine-test/changed", version: "1.0.1" },
    { name: "@usine-test/unchanged", version: "1.0.0" },
    { name: "@usine-test/private", version: "1.0.0", private: true },
  ];
  for (const pkg of packages) {
    const path = join(directory, "packages", pkg.name.split("/")[1]);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "package.json"), JSON.stringify(pkg));
  }

  let approved = false;
  const writes = [];
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    const path = decodeURIComponent(request.url);
    if (request.method === "GET") {
      const name = path.slice(1);
      const version = approved && name === packages[0].name ? "1.0.1" : "1.0.0";
      response.end(
        JSON.stringify({
          name,
          "dist-tags": { latest: version },
          versions: { [version]: { name, version, dist: { tarball: `${registry}unused.tgz` } } },
        }),
      );
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    writes.push({ method: request.method, path, body: JSON.parse(body) });
    response.end(JSON.stringify({ stageId: "123e4567-e89b-12d3-a456-426614174000" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const registry = `http://127.0.0.1:${server.address().port}/`;
  await writeFile(
    join(directory, ".npmrc"),
    `registry=${registry}\nfetch-retries=0\n//127.0.0.1:${server.address().port}/:_authToken=fixture-token\n`,
  );
  const stage = () =>
    exec("pnpm", ["stage", "publish", "-r", "--tag", "latest", "--no-git-checks"], {
      cwd: directory,
      timeout: 30_000,
    });

  await stage();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, "POST");
  assert.equal(writes[0].path, "/-/stage/package/@usine-test/changed");
  assert.deepEqual(writes[0].body["dist-tags"], { latest: "1.0.1" });
  assert.deepEqual(Object.keys(writes[0].body.versions), ["1.0.1"]);

  approved = true;
  await stage();
  assert.equal(writes.length, 1);
});

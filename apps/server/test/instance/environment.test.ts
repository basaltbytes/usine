import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { assert, it } from "vitest";
import { Port, SERVER_HOST } from "../../src/cli.ts";

const cli = fileURLToPath(new URL("../../dist/main.js", import.meta.url));
const test = it.extend<{ directory: string }>({
  directory: async ({ task }, use) => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), `usine-environment-${task.id}-`)),
    );
    try {
      await use(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
});

// A cold CLI start in a parallel `pnpm test` exceeds vitest's 5 s default. The test timeout is
// above the spawn timeout so a slow CLI fails with the spawn's diagnostics.
const slowCli = { timeout: 30_000 };

/** Runs the CLI with `shell` as its whole environment, apart from `PATH` and `HOME`. */
const runCli = (
  directory: string,
  args: ReadonlyArray<string>,
  shell: Readonly<Record<string, string>>,
) =>
  spawnSync(process.execPath, [cli, ...args], {
    cwd: directory,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...shell },
    timeout: 15_000,
  });

const PortAddress = Schema.Struct({ port: Port });

const freePort = () =>
  new Promise<Port>((resolve) => {
    const server = createServer();
    server.listen({ host: SERVER_HOST, port: 0 }, () => {
      const { port } = Schema.decodeUnknownSync(PortAddress)(server.address());
      server.close(() => resolve(port));
    });
  });

test(
  "usine up reads the variables that the shell doesn't set from .env",
  slowCli,
  async ({ directory }) => {
    await mkdir(join(directory, "agents"));
    await mkdir(join(directory, "loops"));
    await writeFile(
      join(directory, "usine.yaml"),
      "version: 1\nrepos: []\ntracing:\n  otlp_url: http://127.0.0.1:4318/v1/traces\n",
    );
    await writeFile(
      join(directory, ".env"),
      "USINE_PORT=not-a-port\nOTEL_RESOURCE_ATTRIBUTES=team=100%\n",
    );

    const result = runCli(directory, ["up", "--allow-volatile-instance"], {
      USINE_PORT: String(await freePort()),
    });

    // The shell's port wins over .env's, so startup reaches the tracing block, which reads .env.
    assert.strictEqual(result.error, undefined);
    assert.strictEqual(result.status, 1, result.stderr);
    assert.match(result.stderr, /OTEL_RESOURCE_ATTRIBUTES is invalid/u);
  },
);

test(
  "stops a command with the path of a .env that it can't read",
  slowCli,
  async ({ directory }) => {
    await mkdir(join(directory, ".env"));

    const result = runCli(directory, ["status"], {});

    assert.strictEqual(result.error, undefined);
    assert.strictEqual(result.status, 1, result.stderr);
    assert.include(result.stderr, `Could not read ${join(directory, ".env")}`);
  },
);

import { describe, expect, it } from "@effect/vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DRAIN_MARKER,
  PROVIDER_HOSTS,
  PROCESSES_DIRECTORY,
  SANDBOX_HOME,
} from "../src/api/harness.ts";

// turbo.json lists the cloud-init file as an input of this package's tests.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const dockerfile = read("../image/Dockerfile");
const npmPins = (source: string) =>
  Object.fromEntries(
    [...source.matchAll(/(pnpm|@anthropic-ai\/claude-code|@openai\/codex)@(\S+)/gu)].map(
      ([, name, version]) => [name, version],
    ),
  );

describe("sandbox image", () => {
  it("installs the harness versions of the Hetzner worker image", () => {
    const pins = npmPins(dockerfile);

    expect(Object.keys(pins)).toHaveLength(3);
    expect(pins).toEqual(npmPins(read("../../../infra/hetzner/cloud-init.yaml")));
  });

  it("points Codex at the OpenAI handler with the placeholder's variable", () => {
    const codex = read("../image/codex-config.toml");

    expect(codex).toContain(`base_url = "http://${PROVIDER_HOSTS.openai.sandbox}/v1"`);
    expect(codex).toContain('env_key = "OPENAI_API_KEY"');
    expect(codex).toMatch(/^model_provider = "usine"$/mu);
  });

  it("creates the home and processes directories that the Worker writes to", () => {
    expect(dockerfile).toContain(`WORKDIR ${SANDBOX_HOME}`);
    expect(dockerfile).toContain(PROCESSES_DIRECTORY);
    expect(dockerfile).toContain(
      `COPY --chown=usine:usine codex-config.toml ${SANDBOX_HOME}/.codex/config.toml`,
    );
  });

  it("records the platform's SIGTERM in the drain marker and keeps running", async () => {
    expect(DRAIN_MARKER).toBe(`${SANDBOX_HOME}/.usine/draining`);
    expect(dockerfile).toContain(`ENV HOME=${SANDBOX_HOME}`);
    expect(dockerfile).toContain('CMD ["/usr/local/bin/usine-sandbox-init"]');
    const home = mkdtempSync(join(tmpdir(), "usine-sandbox-init-"));
    const marker = join(home, ".usine", "draining");
    const init = spawn("sh", [fileURLToPath(new URL("../image/init.sh", import.meta.url))], {
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: home },
      stdio: "ignore",
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      init.kill("SIGTERM");
      for (let waited = 0; waited < 5_000 && !existsSync(marker); waited += 50)
        await new Promise((resolve) => setTimeout(resolve, 50));

      expect(readFileSync(marker, "utf8")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\n$/u);
      expect(init.exitCode).toBeNull();
      expect(init.signalCode).toBeNull();
    } finally {
      init.kill("SIGKILL");
    }
  });
});

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CODEX_PROTOCOL } from "../../src/protocol/codex/version.ts";

const script = fileURLToPath(new URL("generate.mjs", import.meta.url));
const copy = fileURLToPath(
  new URL("../../src/protocol/codex/upstream-schema.json", import.meta.url),
);

/** Runs the generator with `fetch` replaced by `stub`, a JavaScript function expression. */
const generate = (stub, ...args) =>
  spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--import",
      `data:text/javascript,${encodeURIComponent(`import { readFileSync } from "node:fs";globalThis.fetch = ${stub};`)}`,
      "--experimental-strip-types",
      script,
      ...args,
    ],
    { encoding: "utf8", timeout: 60_000 },
  );

const unreachable = `async () => { throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND raw.githubusercontent.com") }); }`;

describe("codex generator", () => {
  it("checks the generated schemas against the local copy without fetching", () => {
    const result = generate(unreachable, "--check");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  }, 60_000);

  it("reports an unreachable upstream in one line after checking the local copy", () => {
    const result = generate(unreachable, "--check", "--upstream");
    expect(result.stderr).toBe(
      "upstream fetch failed: getaddrinfo ENOTFOUND raw.githubusercontent.com; the local copy was checked\n",
    );
    expect(result.status).toBe(2);
  }, 60_000);

  it("reports an HTTP failure from upstream in one line", () => {
    const result = generate(
      `async () => new Response("", { status: 403, statusText: "Forbidden" })`,
      "--check",
      "--upstream",
    );
    expect(result.stderr).toBe(
      "upstream fetch failed: HTTP 403 Forbidden; the local copy was checked\n",
    );
    expect(result.status).toBe(2);
  }, 60_000);

  it("names the local copy and the pinned upstream file when they differ", () => {
    const result = generate(
      `async () => new Response(readFileSync(${JSON.stringify(copy)}, "utf8") + "\\n")`,
      "--check",
      "--upstream",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `src/protocol/codex/upstream-schema.json does not match https://raw.githubusercontent.com/openai/codex/${CODEX_PROTOCOL.commit}/`,
    );
  }, 60_000);

  it("accepts a local copy identical to the pinned upstream file", () => {
    const result = generate(
      `async () => new Response(readFileSync(${JSON.stringify(copy)}, "utf8"))`,
      "--check",
      "--upstream",
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  }, 60_000);
});

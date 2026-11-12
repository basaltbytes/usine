import { assert, describe, it } from "@effect/vitest";
import { CredentialId } from "../../src/auth/model.ts";
import { sessionTable } from "../../src/mcp/sessions.ts";

const owner = CredentialId.make("owner");

describe("MCP session table", () => {
  it("returns an idle session once, and again only after a retry", () => {
    const sessions = sessionTable(1_000);
    sessions.open("s1", { credential: owner, tools: "detail", lastUsedAt: 0 });
    const stale = sessions.takeStale(1_000);
    assert.deepEqual(
      stale.map(({ id, reason }) => [id, reason]),
      [["s1", "idle"]],
    );
    assert.deepEqual(sessions.takeStale(2_000), []);
    for (const ending of stale) sessions.retry(ending);
    assert.deepEqual(
      sessions.takeStale(2_000).map(({ id, reason }) => [id, reason]),
      [["s1", "idle"]],
    );
    assert.deepEqual(sessions.takeStale(3_000), []);
  });

  it("refuses a session that waits for a retry", () => {
    const sessions = sessionTable(1_000);
    sessions.open("s1", { credential: owner, tools: "detail", lastUsedAt: 0 });
    for (const ending of sessions.takeStale(1_000)) sessions.retry(ending);
    assert.equal(sessions.admit("s1", owner, "detail", 1_000)._tag, "Unknown");
  });
});

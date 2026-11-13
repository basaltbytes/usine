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

  it("settles a session that its tool server ended or no longer has", () => {
    const sessions = sessionTable(1_000);
    sessions.open("s1", { credential: owner, tools: "detail", lastUsedAt: 0 });
    sessions.open("s2", { credential: owner, tools: "detail", lastUsedAt: 0 });
    const [first, second] = sessions.takeStale(1_000);
    assert.isDefined(first);
    assert.isDefined(second);
    assert.equal(sessions.settle(first, 204)._tag, "Ended");
    assert.equal(sessions.settle(second, 404)._tag, "Gone");
    assert.deepEqual(sessions.takeStale(2_000), []);
  });

  it("keeps a session that its tool server refused for the next sweep", () => {
    const sessions = sessionTable(1_000);
    sessions.open("s1", { credential: owner, tools: "detail", lastUsedAt: 0 });
    for (const ending of sessions.takeStale(1_000))
      assert.equal(sessions.settle(ending, 403)._tag, "Refused");
    assert.deepEqual(
      sessions.takeStale(2_000).map(({ id, reason }) => [id, reason]),
      [["s1", "idle"]],
    );
  });

  it("forgets a session that its client ended, and keeps one whose end was refused", () => {
    const sessions = sessionTable(1_000);
    for (const id of ["s1", "s2", "s3"])
      sessions.open(id, { credential: owner, tools: "detail", lastUsedAt: 0 });
    assert.equal(sessions.close("s1", 204)._tag, "Ended");
    assert.equal(sessions.close("s2", 404)._tag, "Gone");
    assert.equal(sessions.close("s3", 400)._tag, "Refused");
    assert.equal(sessions.admit("s1", owner, "detail", 10)._tag, "Unknown");
    assert.equal(sessions.admit("s2", owner, "detail", 10)._tag, "Unknown");
    assert.equal(sessions.admit("s3", owner, "detail", 10)._tag, "Admitted");
    assert.deepEqual(
      sessions.takeStale(1_010).map(({ id, reason }) => [id, reason]),
      [["s3", "idle"]],
    );
  });

  it("ends a session whose tool list changed at the next sweep", () => {
    const sessions = sessionTable(1_000);
    sessions.open("s1", { credential: owner, tools: "detail", lastUsedAt: 0 });
    assert.equal(sessions.admit("s1", owner, "detail,approve", 10)._tag, "ToolsChanged");
    assert.equal(sessions.admit("s1", owner, "detail,approve", 20)._tag, "Unknown");
    assert.deepEqual(
      sessions.takeStale(30).map(({ id, reason }) => [id, reason]),
      [["s1", "tools-changed"]],
    );
  });
});

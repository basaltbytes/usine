// Deletes a probe machine while an Exec stream runs on it, and reports how the stream ends.
// Usage: node destroy-under-stream.mjs <suffix>
import { scrub, assertMine, client, now, PREFIX, openExec, rawClient } from "./lib.mjs";

const name = `${PREFIX}${process.argv[2]}`;
assertMine(name);
const boxd = client();
const m = await boxd.machines.get(name);
const c = rawClient();
const { call, done } = openExec(c, m.id, "echo running; sleep 600");
const t = now();
done.then((r) =>
  console.log(JSON.stringify({ event: "stream-ended", sinceDeleteMs: Math.round(now() - t), exitChunk: r.exitChunk ? { exitCode: r.exitChunk.exitCode } : undefined, error: r.error ? { code: r.error.code, details: scrub(r.error.details) } : undefined })),
);
await new Promise((r) => setTimeout(r, 2000));
await boxd.machines.delete(m.id);
console.log(JSON.stringify({ event: "deleted", ms: Math.round(now() - t) }));
await Promise.race([done, new Promise((r) => setTimeout(r, 60_000))]);
try {
  await boxd.machines.get(m.id);
  console.log(JSON.stringify({ event: "still-listed" }));
} catch (e) {
  console.log(JSON.stringify({ event: "get-after-delete", error: e?.constructor?.name }));
}
call.cancel();
c.close();
process.exit();

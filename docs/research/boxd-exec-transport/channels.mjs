// Output rate with one HTTP/2 connection per stream, and concurrent stream count on one machine.
// Usage: node channels.mjs <machine id> <streams for the concurrency test>
import { scrub, now, openExec, rawClient } from "./lib.mjs";

const [vmId, concurrentArg] = process.argv.slice(2);
const out = (o) => console.log(JSON.stringify(o));

{
  const t = now();
  const each = await Promise.all(
    Array.from({ length: 4 }, async () => {
      const c = rawClient();
      const ts = now();
      const { call, done } = openExec(c, vmId, "head -c 4194304 /dev/zero");
      call.end();
      await done;
      c.close();
      return Math.round(now() - ts);
    }),
  );
  out({ label: "download-4MB-x4-separate-connections", ms: Math.round(now() - t), aggregateMBps: Math.round(((4 * 4.194304) / ((now() - t) / 1000)) * 10) / 10, each });
}

{
  const n = Number(concurrentArg ?? 50);
  const c = rawClient();
  const t = now();
  const results = await Promise.all(
    Array.from({ length: n }, async () => {
      const { call, done } = openExec(c, vmId, "sleep 20; echo ok");
      call.end();
      const r = await done;
      return r.error ? `error ${r.error.code} ${scrub(r.error.details)}` : `exit ${r.exitChunk?.exitCode}`;
    }),
  );
  const counts = {};
  for (const r of results) counts[r] = (counts[r] ?? 0) + 1;
  out({ label: `concurrent-sleep20-x${n}-one-connection`, ms: Math.round(now() - t), counts });
  c.close();
}

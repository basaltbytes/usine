// Follow-ups: stdin message size threshold, per-stream output rate, and the SDK's streamExec rate.
// Usage: node framing2.mjs <machine id> <suffix>
import { scrub, client as sdkClient, now, PREFIX, openExec, rawClient, writeStdin } from "./lib.mjs";

const [vmId, suffix] = process.argv.slice(2);
const client = rawClient();
const out = (o) => console.log(JSON.stringify(o));
const decoder = new TextDecoder();

const run = async (command, parts = []) => {
  let text = "";
  let bytes = 0;
  const t = now();
  const { call, done } = openExec(client, vmId, command, {
    onData: (c) => {
      bytes += c.data.length;
      if (bytes < 4096) text += decoder.decode(c.data);
    },
  });
  for (const p of parts) writeStdin(call, p);
  call.end();
  const r = await done;
  return { ms: Math.round(now() - t), text: scrub(text).trim().slice(0, 200), bytes, exitCode: r.exitChunk?.exitCode, chunks: r.received.length, error: r.error ? { code: r.error.code, details: scrub(r.error.details) } : undefined };
};

for (const size of [4 * 1024 * 1024 - 1024, 4 * 1024 * 1024 - 64, 4 * 1024 * 1024, 5 * 1024 * 1024]) {
  out({ label: "single-chunk-wc", size, ...(await run("wc -c; echo after", [Buffer.alloc(size, 65)])) });
}
out({ label: "small-then-big-then-small", ...(await run("wc -c", [Buffer.alloc(10, 65), Buffer.alloc(5 * 1024 * 1024, 65), Buffer.alloc(10, 65)])) });

for (const parallel of [1, 4]) {
  const t = now();
  const results = await Promise.all(Array.from({ length: parallel }, () => run("head -c 8388608 /dev/zero")));
  const ms = now() - t;
  out({ label: `download-8MB-x${parallel}`, ms: Math.round(ms), aggregateMBps: Math.round(((parallel * 8.388608) / (ms / 1000)) * 10) / 10, each: results.map((r) => r.ms) });
}
out({ label: "download-8MB-gzip-stdout-small-reads", ...(await run("head -c 8388608 /dev/zero | dd bs=65536 2>/dev/null | wc -c")) });

{
  const boxd = sdkClient();
  const t = now();
  let bytes = 0;
  const s = boxd.machines.streamExec(`${PREFIX}${suffix}`, { command: "head -c 8388608 /dev/zero", closeStdin: true });
  for await (const c of s) bytes += c.length;
  await s.wait();
  out({ label: "sdk-streamExec-download-8MB", bytes, ms: Math.round(now() - t) });
  const t2 = now();
  const r = await boxd.machines.exec(`${PREFIX}${suffix}`, { command: "head -c 8388608 /dev/zero", encoding: "buffer" });
  out({ label: "sdk-exec-download-8MB", bytes: r.stdout.length, ms: Math.round(now() - t2) });
}
client.close();
process.exit();

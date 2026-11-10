// Output rate as a function of the client's HTTP/2 receive window. Usage: node window.mjs <machine id>
import { now, openExec, rawClient } from "./lib.mjs";

const vmId = process.argv[2];
for (const windowBytes of [undefined, 1024 * 1024, 8 * 1024 * 1024, 32 * 1024 * 1024]) {
  const c = rawClient({ windowBytes });
  const results = [];
  for (const [label, command] of [
    ["download-16MB", "head -c 16777216 /dev/zero"],
    ["download-16MB-random", "head -c 16777216 /dev/urandom"],
  ]) {
    const t = now();
    let bytes = 0;
    const { call, done } = openExec(c, vmId, command, { onData: (x) => (bytes += x.data.length) });
    call.end();
    await done;
    const ms = now() - t;
    results.push({ label, bytes, ms: Math.round(ms), mbPerS: Math.round((bytes / 1e6 / (ms / 1000)) * 10) / 10 });
  }
  const t = now();
  const four = await Promise.all(Array.from({ length: 4 }, async () => {
    let bytes = 0;
    const { call, done } = openExec(c, vmId, "head -c 8388608 /dev/zero", { onData: (x) => (bytes += x.data.length) });
    call.end();
    await done;
    return bytes;
  }));
  const ms = now() - t;
  results.push({ label: "4x8MB-same-connection", aggregateMBps: Math.round((four.reduce((a, b) => a + b, 0) / 1e6 / (ms / 1000)) * 10) / 10 });
  console.log(JSON.stringify({ windowBytes: windowBytes ?? "default", results }));
  c.close();
}

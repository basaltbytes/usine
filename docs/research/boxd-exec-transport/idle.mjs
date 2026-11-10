// Long idle Exec streams. Usage: node idle.mjs <machine id> <suffix> <idle minutes> <total minutes>
// Streams: raw without keepalive, raw with 30 s HTTP/2 keepalive, SDK streamExec, and a command
// with no traffic at all. After the idle period, each echo stream gets one line every 30 s.
import { scrub, client as sdkClient, now, PREFIX, openExec, rawClient, writeStdin } from "./lib.mjs";

const [vmId, suffix, idleArg, totalArg] = process.argv.slice(2);
const idleMs = Number(idleArg) * 60_000;
const totalMs = Number(totalArg) * 60_000;
const t0 = now();
const log = (o) => console.log(JSON.stringify({ min: Math.round((now() - t0) / 600) / 100, ...o }));
const enc = new TextEncoder();

const rawEcho = (label, keepaliveMs) => {
  const c = rawClient({ keepaliveMs });
  let echoed = 0;
  const { call, done } = openExec(c, vmId, "cat", { onData: (x) => { if (x.data.length) echoed++; } });
  done.then((r) => log({ label, event: "ended", error: r.error ? { code: r.error.code, details: scrub(r.error.details) } : undefined, exitCode: r.exitChunk?.exitCode, echoed }));
  return { label, send: (s) => writeStdin(call, enc.encode(s)), echoed: () => echoed, close: () => { call.end(); setTimeout(() => c.close(), 2000); } };
};

const sdkEcho = () => {
  const boxd = sdkClient();
  let echoed = 0;
  const s = boxd.machines.streamExec(`${PREFIX}${suffix}`, { command: "cat" });
  (async () => {
    try {
      for await (const x of s) if (x.length) echoed++;
      log({ label: "sdk", event: "ended", exitCode: s.exitCode, echoed });
    } catch (e) {
      log({ label: "sdk", event: "ended", error: scrub(`${e?.constructor?.name}: ${e?.message}`), echoed });
    }
  })();
  return { label: "sdk", send: (x) => s.write(x), echoed: () => echoed, close: () => s.end() };
};

const silent = (() => {
  const c = rawClient();
  const seconds = Math.round(totalMs / 1000);
  const { call, done } = openExec(c, vmId, `sleep ${seconds}; echo silent-done`, {
    onData: (x) => { if (x.data.length) log({ label: "silent", event: "output", text: new TextDecoder().decode(x.data).trim() }); },
  });
  done.then((r) => log({ label: "silent", event: "ended", error: r.error ? { code: r.error.code, details: scrub(r.error.details) } : undefined, exitCode: r.exitChunk?.exitCode }));
  return call;
})();

const streams = [rawEcho("raw-no-keepalive"), rawEcho("raw-keepalive-30s", 30_000), sdkEcho()];
for (const s of streams) s.send("hello\n");
setTimeout(() => log({ event: "initial-echo", counts: streams.map((s) => [s.label, s.echoed()]) }), 3000);

setTimeout(() => {
  log({ event: "idle-over" });
  let tick = 0;
  const timer = setInterval(() => {
    tick++;
    for (const s of streams) s.send(`tick ${tick}\n`);
    setTimeout(() => {
      if (tick % 4 === 1) log({ event: "tick", tick, counts: streams.map((s) => [s.label, s.echoed()]) });
    }, 2000);
    if (now() - t0 > totalMs) {
      clearInterval(timer);
      setTimeout(() => {
        log({ event: "final", counts: streams.map((s) => [s.label, s.echoed()]) });
        for (const s of streams) s.close();
        silent.end();
        setTimeout(() => process.exit(0), 70_000);
      }, 3000);
    }
  }, 30_000);
}, idleMs);

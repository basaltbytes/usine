// Child-host-shaped traffic over one Exec stream to `cat`: ordering, size limits, binary safety,
// throughput, and backpressure. Usage: node framing.mjs <machine id>
import { createHash, randomBytes } from "node:crypto";
import { scrub, now, openExec, rawClient, writeStdin } from "./lib.mjs";

const vmId = process.argv[2];
const client = rawClient();
const out = (o) => console.log(JSON.stringify(o));
const errorOf = (r) => (r.error ? { code: r.error.code, details: scrub(r.error.details) } : undefined);

/** Writes `parts` honoring backpressure; returns stats on false returns and drain waits. */
const pump = async (call, parts) => {
  let falses = 0;
  let waited = 0;
  for (const p of parts) {
    if (!writeStdin(call, p)) {
      falses++;
      const t = now();
      await new Promise((r) => call.once("drain", r));
      waited += now() - t;
    }
  }
  call.end();
  return { falses, drainWaitMs: Math.round(waited) };
};

const echo = async (label, parts, { command = "cat", expect } = {}) => {
  const t = now();
  const hash = createHash("sha256");
  let bytes = 0;
  let maxChunk = 0;
  let outChunks = 0;
  let firstByteMs;
  const { call, done } = openExec(client, vmId, command, {
    onData: (c) => {
      if (c.isStderr || c.data.length === 0) return;
      firstByteMs ??= now() - t;
      hash.update(c.data);
      bytes += c.data.length;
      outChunks++;
      maxChunk = Math.max(maxChunk, c.data.length);
    },
  });
  const pumped = await pump(call, parts);
  const r = await done;
  const ms = now() - t;
  const digest = hash.digest("hex");
  out({
    label,
    inBytes: parts.reduce((n, p) => n + p.length, 0),
    outBytes: bytes,
    match: expect === undefined ? undefined : digest === expect,
    ms: Math.round(ms),
    mbPerS: Math.round((bytes / 1e6 / (ms / 1000)) * 10) / 10,
    firstByteMs: firstByteMs === undefined ? undefined : Math.round(firstByteMs),
    outChunks,
    maxChunk,
    exitCode: r.exitChunk?.exitCode,
    error: errorOf(r),
    ...pumped,
  });
};

const sha = (parts) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest("hex");
};
const enc = new TextEncoder();
const split = (buf, size) => {
  const parts = [];
  for (let i = 0; i < buf.length; i += size) parts.push(buf.subarray(i, i + size));
  return parts;
};

// 1. Small NDJSON messages, one ExecChunk each, then check ordering on the way back.
{
  const n = 20_000;
  const lines = Array.from({ length: n }, (_, i) => enc.encode(`${JSON.stringify({ seq: i, pad: "x".repeat(80) })}\n`));
  const t = now();
  let buffer = "";
  let next = 0;
  let disorder = 0;
  const decoder = new TextDecoder();
  const { call, done } = openExec(client, vmId, "cat", {
    onData: (c) => {
      if (c.isStderr || c.data.length === 0) return;
      buffer += decoder.decode(c.data, { stream: true });
      const parts = buffer.split("\n");
      buffer = parts.pop();
      for (const line of parts) {
        if (JSON.parse(line).seq !== next) disorder++;
        next++;
      }
    },
  });
  const pumped = await pump(call, lines);
  const r = await done;
  const ms = now() - t;
  out({ label: "small-ndjson-20k", received: next, disorder, ms: Math.round(ms), msgPerS: Math.round(n / (ms / 1000)), exitCode: r.exitChunk?.exitCode, error: errorOf(r), ...pumped });
}

// 2. Large lines, sent in 64 KiB chunks.
for (const mb of [1, 8, 32]) {
  const line = Buffer.concat([Buffer.from(randomBytes((mb * 1024 * 1024 * 3) / 4).toString("base64")), Buffer.from("\n")]);
  const parts = split(line, 64 * 1024);
  await echo(`line-${mb}MB-64KiB-chunks`, parts, { expect: sha(parts) });
}

// 3. One ExecChunk per message regardless of size: the server's message size limit.
for (const mb of [1, 4, 8, 16]) {
  const buf = randomBytes(mb * 1024 * 1024);
  await echo(`single-chunk-${mb}MB`, [buf], { expect: sha([buf]) });
}

// 4. Binary safety: every byte value, including NUL and invalid UTF-8.
{
  const buf = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < buf.length; i++) buf[i] = i % 256;
  const parts = split(buf, 32 * 1024);
  await echo("binary-all-bytes-1MB", parts, { expect: sha(parts) });
}

// 5. Download and upload throughput.
await echo("download-64MB", [], { command: "head -c 67108864 /dev/zero" });
{
  const parts = split(Buffer.alloc(64 * 1024 * 1024, 7), 256 * 1024);
  await echo("upload-64MB", parts, { command: "cat >/dev/null; echo done" });
}

// 6. Backpressure: the remote reads nothing for 10 s.
{
  const parts = split(Buffer.alloc(128 * 1024 * 1024, 1), 64 * 1024);
  const rss0 = process.memoryUsage().rss;
  let peak = rss0;
  const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 50);
  await echo("backpressure-128MB-slow-reader", parts, { command: "sleep 10; cat >/dev/null; echo done" });
  clearInterval(timer);
  out({ label: "backpressure-rss", rssGrowthMB: Math.round((peak - rss0) / 1e6) });
}
client.close();

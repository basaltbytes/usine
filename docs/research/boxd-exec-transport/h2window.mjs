// Exec over plain node:http2 with gRPC framing, to separate the stream window (SETTINGS, which
// connect-node's http2SessionOptions can set) from the connection window (setLocalWindowSize).
// Usage: node h2window.mjs <machine id>
import http2 from "node:http2";
import { apiKey, now, ExecChunk } from "./lib.mjs";

const vmId = process.argv[2];
const frame = (msg) => {
  const body = ExecChunk.encode(msg).finish();
  const out = Buffer.alloc(5 + body.length);
  out.writeUInt32BE(body.length, 1);
  Buffer.from(body).copy(out, 5);
  return out;
};
const base = { data: new Uint8Array(), stdin: false, tty: false, command: "", vmId: "", exitCode: 0, cols: 0, rows: 0, windowChange: false, isStderr: false, deviceId: "" };

const download = (streamWindow, connectionWindow) =>
  new Promise((resolve) => {
    const session = http2.connect("https://fra.boxd.sh:9443", streamWindow ? { settings: { initialWindowSize: streamWindow } } : {});
    session.on("connect", () => {
      if (connectionWindow) session.setLocalWindowSize(connectionWindow);
      const t = now();
      let bytes = 0;
      const req = session.request({
        ":method": "POST",
        ":path": "/boxd.api.v1.BoxdApi/Exec",
        "content-type": "application/grpc",
        te: "trailers",
        authorization: `Bearer ${apiKey()}`,
      });
      req.on("data", (d) => (bytes += d.length));
      req.on("end", () => {
        const ms = now() - t;
        session.close();
        resolve({ streamWindow: streamWindow ?? "default", connectionWindow: connectionWindow ?? "default", wireBytes: bytes, ms: Math.round(ms), mbPerS: Math.round((bytes / 1e6 / (ms / 1000)) * 10) / 10 });
      });
      req.write(frame({ ...base, vmId, command: "head -c 16777216 /dev/zero" }));
      req.end();
    });
  });

console.log(JSON.stringify(await download()));
console.log(JSON.stringify(await download(8 * 1024 * 1024)));
console.log(JSON.stringify(await download(8 * 1024 * 1024, 8 * 1024 * 1024)));

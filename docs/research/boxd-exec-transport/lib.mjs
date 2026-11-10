// Shared helpers for the boxd exec probes in docs/research/boxd-exec-transport.md.
//
// Set BOXD_API_KEY, and BOXD_SDK_DIR to a directory where
// `npm install --ignore-scripts @boxd-sh/sdk@0.3.0` ran. The probes only touch machines whose
// names start with probe-1106-, and never print the key.
import { pathToFileURL } from "node:url";

const sdkDir = process.env.BOXD_SDK_DIR;
if (!sdkDir) throw new Error("Set BOXD_SDK_DIR");
const modules = (path) => pathToFileURL(`${sdkDir}/node_modules/${path}`).href;

export const sdk = await import(modules("@boxd-sh/sdk/dist/index.js"));
const grpc = await import(modules("@grpc/grpc-js/build/src/index.js"));
const { BoxdApiDefinition } = await import(modules("@boxd-sh/sdk/dist/_generated/definitions.js"));
export const { ExecChunk } = await import(modules("@boxd-sh/sdk/dist/_generated/api.js"));

export const apiKey = () => {
  const key = process.env.BOXD_API_KEY;
  if (!key) throw new Error("Set BOXD_API_KEY");
  return key;
};

export const scrub = (text) => String(text).replaceAll(apiKey(), "[redacted]");

export const PREFIX = "probe-1106-";

export const assertMine = (name) => {
  if (!String(name).startsWith(PREFIX)) throw new Error(`refusing to touch ${name}`);
};

export const client = (opts = {}) => new sdk.Boxd({ apiKey: apiKey(), region: "fra", ...opts });

export const now = () => performance.now();

export const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return {
    n: sorted.length,
    median: Math.round(median),
    min: Math.round(sorted[0]),
    max: Math.round(sorted.at(-1)),
  };
};

// Raw Exec calls over grpc-js: the API key as the bearer, no SDK buffering, and the HTTP/2 options
// the SDK doesn't set.
const method = BoxdApiDefinition.methods.exec;
const path = `/${BoxdApiDefinition.fullName}/${method.name}`;
const serialize = (value) => Buffer.from(method.requestType.encode(value).finish());
const deserialize = (bytes) => method.responseType.decode(bytes);

export const chunk = (fields) => ({
  data: new Uint8Array(),
  stdin: false,
  tty: false,
  command: "",
  vmId: "",
  exitCode: 0,
  cols: 0,
  rows: 0,
  windowChange: false,
  isStderr: false,
  deviceId: "",
  ...fields,
});

export const rawClient = ({ endpoint = "fra.boxd.sh:9443", keepaliveMs, windowBytes } = {}) => {
  const options = {
    "grpc.max_receive_message_length": 64 * 1024 * 1024,
    "grpc.max_send_message_length": 64 * 1024 * 1024,
  };
  if (windowBytes !== undefined) options["grpc-node.flow_control_window"] = windowBytes;
  if (keepaliveMs !== undefined) {
    options["grpc.keepalive_time_ms"] = keepaliveMs;
    options["grpc.keepalive_timeout_ms"] = 20_000;
    options["grpc.keepalive_permit_without_calls"] = 1;
  }
  return new grpc.Client(endpoint, grpc.credentials.createSsl(), options);
};

export const metadata = (bearer = apiKey()) => {
  const md = new grpc.Metadata();
  md.add("authorization", `Bearer ${bearer}`);
  return md;
};

/**
 * Opens an Exec stream. `done` resolves with the received chunks, the final chunk (empty data)
 * if one arrived, and the gRPC error if the call failed.
 */
export const openExec = (rpc, vmId, command, { md = metadata(), onData } = {}) => {
  const call = rpc.makeBidiStreamRequest(path, serialize, deserialize, md, {});
  const received = [];
  const done = new Promise((resolve) => {
    let exitChunk;
    call.on("data", (c) => {
      received.push({ len: c.data?.length ?? 0, isStderr: c.isStderr, exitCode: c.exitCode });
      if (c.data?.length === 0) exitChunk = c;
      onData?.(c);
    });
    call.on("error", (err) =>
      resolve({ error: { code: err.code, details: scrub(err.details) }, received, exitChunk }),
    );
    call.on("end", () => resolve({ ok: true, received, exitChunk }));
  });
  call.write(chunk({ vmId, command }));
  return { call, done };
};

export const writeStdin = (call, data) => call.write(chunk({ data, stdin: true }));

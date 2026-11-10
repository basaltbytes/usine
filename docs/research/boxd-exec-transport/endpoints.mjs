// Exec of one machine through each endpoint, and with an invalid bearer. Usage: node endpoints.mjs <machine id> <name>
import { scrub, now, metadata, openExec, rawClient } from "./lib.mjs";

const [vmId, name] = process.argv.slice(2);
const attempt = async (label, endpoint, target, md) => {
  const c = rawClient({ endpoint });
  const t = now();
  let text = "";
  const { call, done } = openExec(c, target, "hostname", { md, onData: (x) => (text += new TextDecoder().decode(x.data)) });
  call.end();
  const r = await done;
  console.log(JSON.stringify({ label, ms: Math.round(now() - t), text: text.trim(), exitCode: r.exitChunk?.exitCode, error: r.error ? { code: r.error.code, details: scrub(r.error.details) } : undefined }));
  c.close();
};
await attempt("fra-by-id", "fra.boxd.sh:9443", vmId);
await attempt("fra-by-name", "fra.boxd.sh:9443", name);
await attempt("account-endpoint-by-id", "boxd.sh:9443", vmId);
await attempt("nyc-endpoint-by-id", "nyc.boxd.sh:9443", vmId);
await attempt("bad-bearer", "fra.boxd.sh:9443", vmId, metadata("bxd_not_a_key"));
await attempt("unknown-machine", "fra.boxd.sh:9443", "00000000-0000-0000-0000-000000000000");
process.exit();

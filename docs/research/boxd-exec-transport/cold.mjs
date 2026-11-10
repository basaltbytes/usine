// One cold Exec of `true` in a fresh process and connection, with the API key as the bearer: the
// cost an ssh stand-in pays per command. Prints the exit code or the error code.
import { scrub, openExec, rawClient } from "./lib.mjs";

const c = rawClient();
const { call, done } = openExec(c, process.argv[2], "true");
call.end();
const r = await done;
console.log(r.error ? `error ${r.error.code} ${scrub(r.error.details)}` : `exit ${r.exitChunk?.exitCode}`);
c.close();
process.exit();

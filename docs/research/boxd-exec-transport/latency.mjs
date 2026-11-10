// Exec startup latency on one machine. Usage: node latency.mjs <suffix> [runs]
import { scrub, client, now, PREFIX, stats } from "./lib.mjs";

const name = `${PREFIX}${process.argv[2]}`;
const runs = Number(process.argv[3] ?? 20);
const boxd = client();
const id = (await boxd.machines.get(name)).id;

const unary = [];
const streamExit = [];
const streamFirstByte = [];
const cold = [];
try {
  await boxd.machines.exec(id, { command: ["true"] });
  for (let i = 0; i < runs; i++) {
    let t = now();
    await boxd.machines.exec(id, { command: ["true"] });
    unary.push(now() - t);

    t = now();
    const s = boxd.machines.streamExec(id, { command: "echo hi", closeStdin: true });
    let first;
    for await (const chunk of s) {
      if (first === undefined && chunk.length > 0) first = now() - t;
    }
    await s.wait();
    streamFirstByte.push(first);
    streamExit.push(now() - t);
  }
  for (let i = 0; i < Math.min(runs, 10); i++) {
    const t = now();
    const fresh = client();
    await fresh.machines.exec(id, { command: ["true"] });
    cold.push(now() - t);
    fresh.close?.();
  }
  console.log(JSON.stringify({
    unaryTrue: stats(unary),
    streamEchoFirstByte: stats(streamFirstByte),
    streamEchoExit: stats(streamExit),
    coldClientUnaryTrue: stats(cold),
  }));
} catch (e) {
  console.error(scrub(`${e?.constructor?.name}: ${e?.message}`));
  process.exitCode = 1;
}
process.exit();

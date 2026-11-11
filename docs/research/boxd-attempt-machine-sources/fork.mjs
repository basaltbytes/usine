// Forks a probe template and times each fork to its first successful exec.
// Usage: node fork.mjs <template name> <suffix> <count> [parallel] [inspect] [warm] [keep]
//   parallel: start all forks at once instead of one after another
//   inspect:  print identity, what the fork carried, and egress successes after the fork
//   warm:     check out the template's mirror, then time pnpm install and a Turbo build
//   keep:     leave the forks running
// The template runs loops started with setsid, so they survive the exec stream:
//   /home/boxd/tick        a timestamp every 50 ms; gaps show when the template was paused.
//   /home/boxd/egress-ok   a timestamp for each successful request to example.com by name.
//   /home/boxd/egress-log  every 100 ms: the timestamp, the HTTP code of a request to
//                          example.com at a fixed address (000 when blocked), and whether an
//                          uncached DNS query for example.com answered.
// Start them on the template with `template.mjs sh`:
//   setsid -f sh -c 'while :; do date +%s%3N; sleep 0.05; done > /home/boxd/tick'
//   setsid -f sh -c 'while :; do if curl -s -m 1 -o /dev/null https://example.com; then date +%s%3N; fi; sleep 0.1; done > /home/boxd/egress-ok'
//   setsid -f sh -c 'while :; do printf "%s %s %s\n" $(date +%s%3N) $(curl -s -m 1 -o /dev/null -w %{http_code} --resolve example.com:443:<address> https://example.com) $(resolvectl query --cache=no example.com >/dev/null 2>&1 && echo dns-ok || echo dns-no); sleep 0.1; done > /home/boxd/egress-log'
import { assertMine, client, firstExec, identity, leakCommand, logger, now, PREFIX, remove, scrub, sh, stats } from "./lib.mjs";

const [template, suffix, countArg, ...flags] = process.argv.slice(2);
assertMine(template);
const boxd = client();
const log = logger();
const IMAGE = "ghcr.io/basaltbytes/usine-worker:claude-2.1.311-codex-0.164.0";
const RUN = (dir) =>
  `docker run --rm -e CI=1 -v usine-pnpm-store:/home/usine/.local/share/pnpm/store -v usine-turbo-cache:/home/usine/.cache/turbo -v ${dir}:/w -w /w ${IMAGE}`;

const forkOne = async (i) => {
  const name = `${PREFIX}${suffix}-${i}`;
  assertMine(name);
  const startEpoch = Date.now();
  const t0 = now();
  const fork = await boxd.machines.fork(template, { name, labels: { "usine.attempt": `fork-${i}` } });
  const callMs = Math.round(now() - t0);
  const first = await firstExec(boxd, fork.id, t0);
  const leaks = await sh(boxd, fork.id, leakCommand(startEpoch));
  return { i, id: fork.id, name, startEpoch, callMs, firstExecMs: first.ms, tries: first.tries, status: fork.status, bootTimeMs: fork.bootTimeMs, leaks };
};

const forks = [];
try {
  const count = Number(countArg);
  const before = await boxd.machines.get(template);
  log("template", { status: before.status, egressAllow: before.egressAllow });
  if (flags.includes("parallel")) {
    forks.push(...(await Promise.all(Array.from({ length: count }, (_, i) => forkOne(i)))));
  } else {
    for (let i = 0; i < count; i++) forks.push(await forkOne(i));
  }
  for (const f of forks) log("fork", f);
  log("stats", { callMs: stats(forks.map((f) => f.callMs)), firstExecMs: stats(forks.map((f) => f.firstExecMs)) });
  const after = await boxd.machines.get(template);
  log("template-after", { status: after.status, hibernatedAt: after.hibernatedAt });

  if (flags.includes("inspect")) {
    const f = forks[0];
    const m = await boxd.machines.get(f.id);
    log("fork-record", {
      status: m.status,
      egressAllow: m.egressAllow,
      labels: m.labels,
      idle: m.idle,
      source: m.source,
      ssh: m.ssh,
      spec: m.spec,
      resources: m.resources,
    });
    log("fork-identity", await identity(boxd, f.id));
    log("template-identity", await identity(boxd, template));
    const carried = {
      tickLoop: await sh(boxd, f.id, "pgrep -fc 'date +%s%3N' || true"),
      lastTick: Number(await sh(boxd, f.id, "tail -n 1 /home/boxd/tick")),
      nowEpoch: Number(await sh(boxd, f.id, "date +%s%3N")),
      egressSuccessesAfterFork: await sh(boxd, f.id, `awk -v t=${f.startEpoch} '$1 > t' /home/boxd/egress-ok | wc -l`),
      egressNow: (await boxd.machines.exec(f.id, { command: "curl -sS -m 4 -o /dev/null -w '%{http_code}' https://example.com 2>&1 || true" })).stdout.trim(),
      files: await sh(boxd, f.id, "ls /home/boxd; du -sh /home/boxd/cache/usine.git 2>/dev/null || true"),
      containers: await sh(boxd, f.id, "docker ps -a --format '{{.Names}}' | wc -l; docker volume ls -q | tr '\\n' ' '"),
    };
    log("fork-carried", carried);
  }

  if (flags.includes("warm")) {
    const f = forks[0];
    const timed = async (label, command) => {
      const t0 = now();
      const out = await sh(boxd, f.id, command, 900_000);
      log("warm", { label, ms: Math.round(now() - t0), tail: out.split("\n").slice(-2).join(" | ").slice(0, 200) });
    };
    await timed("checkout", "git clone -q /home/boxd/cache/usine.git /home/boxd/w2");
    await timed("install", `${RUN("/home/boxd/w2")} pnpm install --frozen-lockfile --reporter=silent 2>&1 | tail -2`);
    await timed("turbo", `${RUN("/home/boxd/w2")} pnpm exec turbo run build --filter=@usine/executor... 2>&1 | tail -4`);
  }

  // An exec would wake a hibernated template, so only a running one is read.
  if (after.status === "running") {
    const gaps = await sh(
      boxd,
      template,
      `awk 'NR > 1 && $1 - p > 200 { print p, $1 - p } { p = $1 }' /home/boxd/tick | tail -n 20`,
    );
    log("template-tick-gaps", { forkStarts: forks.map((f) => f.startEpoch), gaps: gaps.split("\n").filter(Boolean) });
  }
} catch (e) {
  console.error(scrub(`${e?.constructor?.name}: ${e?.stack ?? e?.message}`));
  process.exitCode = 1;
} finally {
  if (!flags.includes("keep"))
    for (const f of forks) {
      await remove(boxd, f.id);
      log("deleted", { name: f.name });
    }
}

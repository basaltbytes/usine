import { describe, expect, it } from "@effect/vitest";
import { ContainerId } from "@usine/core/worker";
import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  KERNEL_LOG_READABLE_SCRIPT,
  KERNEL_MEMORY_SCRIPT,
  killedProcessesFromKernel,
} from "../../src/remote/memory.ts";

const container = ContainerId.make("a".repeat(64));
const other = "b".repeat(64);
const diagnostic = (cgroup: string, command: string, pid: number) =>
  `oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=libpod-${container}.scope,mems_allowed=0,oom_memcg=/user.slice/libpod-${container}.scope,task_memcg=${cgroup},task=${command},pid=${pid},uid=1000`;

describe("kernel OOM process attribution", () => {
  it.live.each(["match", "no match", "unreadable"] as const)(
    "reads the kernel through journalctl, falling back to dmesg filtered on the worker: journal %s",
    (journal) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "usine-kernel-memory-" });
        const created = "2026-11-08T06:00:00.123456789Z";
        yield* fs.writeFileString(
          path.join(directory, "runtime"),
          `#!/bin/sh
[ "$4" = '{{json .Created}}' ] || exit 2
printf '"%s"\\n' '${created}'
`,
          {
            mode: 0o755,
          },
        );
        yield* fs.writeFileString(
          path.join(directory, "journalctl"),
          `#!/bin/sh
[ "$1" = -k ] && [ "$2" = --since ] && [ "$3" = '${created}' ] || exit 2
${
  {
    match: "echo oom-kill:journal-diagnostic",
    // Like journalctl, prints a placeholder when nothing matches, unless quiet.
    "no match": `for arg in "$@"; do [ "$arg" = -q ] && exit 0; done
echo '-- No entries --'`,
    unreadable: "exit 1",
  }[journal]
}
`,
          { mode: 0o755 },
        );
        yield* fs.writeFileString(
          path.join(directory, "dmesg"),
          "#!/bin/sh\necho unrelated-diagnostic\necho oom-kill:ring-buffer-diagnostic\n",
          {
            mode: 0o755,
          },
        );
        const output = yield* spawner.string(
          ChildProcess.make("/bin/sh", ["-c", KERNEL_MEMORY_SCRIPT, "sh", "runtime", "attempt"], {
            env: { PATH: `${directory}:/usr/bin:/bin` },
            extendEnv: false,
          }),
        );
        expect(output).toBe(
          journal === "match"
            ? "source journal\noom-kill:journal-diagnostic\n"
            : "source dmesg\noom-kill:ring-buffer-diagnostic\n",
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live.each([
    { journal: "entry", dmesg: true, readable: true },
    { journal: "entry", dmesg: false, readable: true },
    { journal: "empty", dmesg: true, readable: true },
    { journal: "empty", dmesg: false, readable: false },
    { journal: "absent", dmesg: true, readable: true },
    { journal: "absent", dmesg: false, readable: false },
  ] as const)(
    "checks that the kernel journal or ring buffer is readable: journal $journal, dmesg $dmesg",
    ({ journal, dmesg, readable }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "usine-kernel-log-" });
        if (journal !== "absent")
          yield* fs.writeFileString(
            path.join(directory, "journalctl"),
            `#!/bin/sh
[ "$1" = -k ] && [ "$2" = -b ] || exit 2
for arg in "$@"; do [ "$arg" = -q ] && quiet=1; done
${journal === "entry" ? "echo 'Linux version 6.18.0'" : '[ -n "${quiet:-}" ] || echo "-- No entries --"'}
`,
            { mode: 0o755 },
          );
        yield* fs.writeFileString(
          path.join(directory, "dmesg"),
          dmesg
            ? "#!/bin/sh\necho 'Linux version 6.18.0'\n"
            : "#!/bin/sh\necho 'dmesg: read kernel buffer failed: Operation not permitted' >&2\nexit 1\n",
          { mode: 0o755 },
        );
        // Only the fakes are on the PATH, so a host journalctl can't stand in for an absent one.
        const exitCode = yield* spawner.exitCode(
          ChildProcess.make("/bin/sh", ["-c", KERNEL_LOG_READABLE_SCRIPT], {
            env: { PATH: directory },
            extendEnv: false,
          }),
        );
        expect(exitCode === 0).toBe(readable);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("uses the victim cgroup for Docker and Podman, including nested cgroups", () => {
    const logs = [
      diagnostic(`/docker/${container}`, "node (vitest 1)", 123),
      diagnostic(`/user.slice/libpod-${container}.scope/build`, "esbuild", 456),
      diagnostic(`/system.slice/docker-${container}.scope`, "codex", 789),
      // Podman with the cgroupfs manager names the cgroup without `.scope`.
      diagnostic(`/libpod_parent/libpod-${container}`, "pnpm", 321),
      // The cpuset and OOM ancestor alone do not identify the victim's container.
      diagnostic(`/docker/${other}`, "sibling", 999),
      diagnostic(`/docker/${container}ff`, "prefix collision", 1000),
      `Memory cgroup out of memory: Killed process 123 (node (vitest 1))`,
      "unrelated diagnostic",
    ].join("\n");
    expect(killedProcessesFromKernel(logs, container)).toMatchObject([
      { command: "node (vitest 1)", pid: 123 },
      { command: "esbuild", pid: 456 },
      { command: "codex", pid: 789 },
      { command: "pnpm", pid: 321 },
    ]);
  });

  it("leaves unavailable and malformed identities absent", () => {
    expect(killedProcessesFromKernel("", container)).toEqual([]);
    expect(killedProcessesFromKernel(diagnostic(`/docker/${container}`, "", 0), container)).toEqual(
      [],
    );
  });
});

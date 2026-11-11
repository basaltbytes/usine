import { describe, expect, it } from "@effect/vitest";
import { ContainerId } from "@usine/core/worker";
import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { KERNEL_MEMORY_SCRIPT, killedProcessesFromKernel } from "../../src/remote/memory.ts";

const container = ContainerId.make("a".repeat(64));
const other = "b".repeat(64);
const diagnostic = (cgroup: string, command: string, pid: number) =>
  `oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=libpod-${container}.scope,mems_allowed=0,oom_memcg=/user.slice/libpod-${container}.scope,task_memcg=${cgroup},task=${command},pid=${pid},uid=1000`;

describe("kernel OOM process attribution", () => {
  it.live.each([true, false])(
    "reads the kernel through journalctl, falling back to dmesg filtered on the worker: journal available %s",
    (journalAvailable) =>
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
${journalAvailable ? "echo oom-kill:journal-diagnostic" : "exit 1"}
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
          journalAvailable
            ? "source journal\noom-kill:journal-diagnostic\n"
            : "source dmesg\noom-kill:ring-buffer-diagnostic\n",
        );
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

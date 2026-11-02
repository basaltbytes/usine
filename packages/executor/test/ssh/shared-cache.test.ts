import { it } from "@effect/vitest";
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { onTestFinished } from "vitest";
import { PREPARE_CACHE_SCRIPT } from "../../src/remote/container.ts";

const run = promisify(execFile);

// Executes the image's shell commands against a temporary directory, without a Docker daemon.
const runtime = `#!/bin/sh
set -eu
if [ "$1" = volume ]; then
  if [ "$FAIL_STAGE" = volume ]; then echo "volume create failed" >&2; exit 1; fi
  mkdir -p "$STORE"
  echo 100000 > "$CLOCK_FILE"
  exit 0
fi
echo 100037 > "$CLOCK_FILE"
if [ "$RUNTIME_NAME" = podman ]; then
  case " $* " in *" --userns=keep-id "*) ;; *) echo missing-keep-id >&2; exit 1 ;; esac
fi
while [ "$1" != --entrypoint ]; do shift; done
shift
entrypoint=$1
shift 2
exec "$entrypoint" "$@"
`;

it.each(
  ["usine-pnpm-store", "usine-turbo-cache"].flatMap((volume) =>
    ["1000", "2345"].flatMap((imageUid) =>
      ["docker", "podman"].map((runtimeName) => ({ volume, imageUid, runtimeName })),
    ),
  ),
)(
  "initializes and reuses $volume with $runtimeName for image UID $imageUid without changing another owner",
  async ({ volume, imageUid, runtimeName }) => {
    const directory = await mkdtemp("/tmp/usine-shared-cache-");
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const store = join(directory, "store");
    const docker = join(directory, runtimeName);
    await writeFile(docker, runtime, { mode: 0o755 });
    await writeFile(
      join(directory, "id"),
      '#!/bin/sh\n[ "$1" = -u ] && [ "$2" = usine ]\necho "$IMAGE_UID"\n',
      { mode: 0o755 },
    );
    // Simulates ownership changes without root privileges.
    await writeFile(
      join(directory, "chown"),
      '#!/bin/sh\nset -eu\n[ "$1" = -h ] && [ "$2" = "$IMAGE_UID" ] && [ "$3" = "$STORE" ]\necho "$2" > "$OWNER_FILE"\n',
      { mode: 0o755 },
    );
    const clockFile = join(directory, "clock");
    await writeFile(clockFile, "0");
    await writeFile(join(directory, "date"), '#!/bin/sh\ncat "$CLOCK_FILE"\n', { mode: 0o755 });
    const ownerFile = join(directory, "owner");
    await writeFile(ownerFile, "0");
    await writeFile(
      join(directory, "stat"),
      '#!/bin/sh\n[ "$1" = -c ] && [ "$2" = %u ] && [ "$3" = "$STORE" ]\ncat "$OWNER_FILE"\n',
      { mode: 0o755 },
    );
    const prepare = (uid = imageUid, failStage = "none") =>
      run("sh", ["-c", PREPARE_CACHE_SCRIPT, "sh", runtimeName, "image", volume, "mount", store], {
        env: {
          PATH: `${directory}:${process.env.PATH}`,
          STORE: store,
          RUNTIME_NAME: runtimeName,
          IMAGE_UID: uid,
          OWNER_FILE: ownerFile,
          CLOCK_FILE: clockFile,
          FAIL_STAGE: failStage,
        },
      });

    await assert.rejects(prepare(imageUid, "volume"), /volume create failed/u);
    await assert.rejects(stat(store), /ENOENT/u);
    const first = await prepare();
    assert.strictEqual(first.stdout, "37\n", "the run duration excludes volume creation");
    assert.strictEqual((await readFile(ownerFile, "utf8")).trim(), imageUid);
    assert.strictEqual((await stat(store)).mode & 0o777, 0o755);
    await mkdir(join(store, "v11"));
    await writeFile(join(store, "v11", "package"), "cached package");
    for (const timestamp of ["1793637391N", "17936373913N", ""]) {
      await writeFile(join(directory, "date"), `#!/bin/sh\necho '${timestamp}'\n`, {
        mode: 0o755,
      });
      const prepared = await prepare();
      assert.strictEqual(prepared.stdout, `${timestamp}:${timestamp}\n`);
      assert.strictEqual(prepared.stderr, "");
    }
    await Promise.all([prepare(), prepare()]);
    await assert.rejects(prepare("7001"), new RegExp(`${runtimeName} volume rm ${volume}`, "u"));
    assert.strictEqual((await readFile(ownerFile, "utf8")).trim(), imageUid);
    await writeFile(ownerFile, "0");
    await assert.rejects(prepare(), new RegExp(`${runtimeName} volume rm ${volume}`, "u"));
    assert.strictEqual(await readFile(join(store, "v11", "package"), "utf8"), "cached package");
  },
);

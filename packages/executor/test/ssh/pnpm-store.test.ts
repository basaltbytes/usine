import { it } from "@effect/vitest";
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { onTestFinished } from "vitest";
import { PREPARE_PNPM_STORE_SCRIPT } from "../../src/remote/container.ts";

const run = promisify(execFile);

// Executes the image's shell commands against a temporary directory, without a Docker daemon.
const runtime = `#!/bin/sh
set -eu
if [ "$1" = volume ]; then
  if [ "$FAIL_STAGE" = volume ]; then echo "volume create failed" >&2; exit 1; fi
  mkdir -p "$STORE"
  exit 0
fi
while [ "$1" != --entrypoint ]; do shift; done
shift
entrypoint=$1
shift 2
exec "$entrypoint" "$@"
`;

it.each(["1000", "2345"])(
  "initializes and reuses a store for image UID %s without changing another owner",
  async (imageUid) => {
    const directory = await mkdtemp("/tmp/usine-pnpm-store-");
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const store = join(directory, "store");
    const docker = join(directory, "docker");
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
    const ownerFile = join(directory, "owner");
    await writeFile(ownerFile, "0");
    await writeFile(
      join(directory, "stat"),
      '#!/bin/sh\n[ "$1" = -c ] && [ "$2" = %u ] && [ "$3" = "$STORE" ]\ncat "$OWNER_FILE"\n',
      { mode: 0o755 },
    );
    const prepare = (uid = imageUid, failStage = "none") =>
      run(
        "sh",
        [
          "-c",
          PREPARE_PNPM_STORE_SCRIPT,
          "sh",
          docker,
          "image",
          "usine-pnpm-store",
          "mount",
          store,
        ],
        {
          env: {
            PATH: `${directory}:${process.env.PATH}`,
            STORE: store,
            IMAGE_UID: uid,
            OWNER_FILE: ownerFile,
            FAIL_STAGE: failStage,
          },
        },
      );

    await assert.rejects(prepare(imageUid, "volume"), /volume create failed/u);
    await assert.rejects(stat(store), /ENOENT/u);
    await prepare();
    assert.strictEqual((await readFile(ownerFile, "utf8")).trim(), imageUid);
    assert.strictEqual((await stat(store)).mode & 0o777, 0o755);
    await mkdir(join(store, "v11"));
    await writeFile(join(store, "v11", "package"), "cached package");
    await Promise.all([prepare(), prepare()]);
    await assert.rejects(prepare("7001"), /docker volume rm usine-pnpm-store/u);
    assert.strictEqual((await readFile(ownerFile, "utf8")).trim(), imageUid);
    await writeFile(ownerFile, "0");
    await assert.rejects(prepare(), /docker volume rm usine-pnpm-store/u);
    assert.strictEqual(await readFile(join(store, "v11", "package"), "utf8"), "cached package");
  },
);

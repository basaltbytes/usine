import { it } from "@effect/vitest";
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
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

it("initializes a reusable store without removing packages during concurrent setup", async (context) => {
  const directory = await mkdtemp("/tmp/usine-pnpm-store-");
  context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const store = join(directory, "store");
  const docker = join(directory, "docker");
  await writeFile(docker, runtime, { mode: 0o755 });
  await writeFile(
    join(directory, "id"),
    '#!/bin/sh\nif [ "${2:-}" = usine ]; then echo "$IMAGE_UID"; else echo "$DEFAULT_UID"; fi\n',
    { mode: 0o755 },
  );
  // The real chown needs root on CI hosts whose test user isn't UID 1000.
  await writeFile(
    join(directory, "chown"),
    '#!/bin/sh\n[ "$1" = -h ] && [ "$2" = 1000 ] && [ "$3" = "$STORE" ]\n',
    { mode: 0o755 },
  );
  const prepare = (defaultUid = "1000", imageUid = "1000", failStage = "none") =>
    run(
      "sh",
      ["-c", PREPARE_PNPM_STORE_SCRIPT, "sh", docker, "image", "usine-pnpm-store", "mount", store],
      {
        env: {
          PATH: `${directory}:${process.env.PATH}`,
          STORE: store,
          DEFAULT_UID: defaultUid,
          IMAGE_UID: imageUid,
          FAIL_STAGE: failStage,
        },
      },
    );

  for (const [defaultUid, imageUid] of [
    ["1001", "1001"],
    ["0", "1000"],
    ["1000", "1001"],
  ]) {
    await assert.rejects(
      prepare(defaultUid, imageUid),
      /requires the image to run as usine with UID 1000/u,
    );
    await assert.rejects(stat(store), /ENOENT/u);
  }
  await assert.rejects(prepare("1000", "1000", "volume"), /volume create failed/u);
  await assert.rejects(stat(store), /ENOENT/u);
  await prepare();
  assert.strictEqual((await stat(store)).mode & 0o777, 0o755);
  await mkdir(join(store, "v11"));
  await writeFile(join(store, "v11", "package"), "cached package");
  await Promise.all([prepare(), prepare()]);
  assert.strictEqual(await readFile(join(store, "v11", "package"), "utf8"), "cached package");
});

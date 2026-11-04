import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Config, Option, FileSystem } from "effect";
import { it } from "@effect/vitest";
import { strict as assert } from "node:assert";
// The Node process boundary uses native process handles and synchronous subprocess operations.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFile } from "node:child_process";
// Synchronous Node path callbacks retain the host platform’s path semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join, dirname, basename } from "node:path";
import { promisify } from "node:util";
import {} from "@effect/vitest";
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

it.live.each(
  ["usine-pnpm-store", "usine-turbo-cache"].flatMap((volume) =>
    ["1000", "2345"].flatMap((imageUid) =>
      ["docker", "podman"].map((runtimeName) => ({ volume, imageUid, runtimeName })),
    ),
  ),
)(
  "initializes and reuses $volume with $runtimeName for image UID $imageUid without changing another owner",
  ({ volume, imageUid, runtimeName }) =>
    Effect.gen(function* () {
      const actual2 = yield* Config.option(Config.String("PATH"));
      const environmentPATH1 = Option.getOrUndefined(actual2);
      const directory = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.makeTempDirectory({
          directory: dirname("/tmp/usine-shared-cache-"),
          prefix: basename("/tmp/usine-shared-cache-"),
        }),
      );
      yield* Effect.addFinalizer(() =>
        Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.remove(directory, { recursive: true, force: true }),
        ).pipe(Effect.orDie),
      );
      const store = join(directory, "store");
      const docker = join(directory, runtimeName);
      yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.writeFileString(docker, runtime, { mode: 0o755 }),
      );
      yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.writeFileString(
          join(directory, "id"),
          '#!/bin/sh\n[ "$1" = -u ] && [ "$2" = usine ]\necho "$IMAGE_UID"\n',
          { mode: 0o755 },
        ),
      );
      // Simulates ownership changes without root privileges.
      yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.writeFileString(
          join(directory, "chown"),
          '#!/bin/sh\nset -eu\n[ "$1" = -h ] && [ "$2" = "$IMAGE_UID" ] && [ "$3" = "$STORE" ]\necho "$2" > "$OWNER_FILE"\n',
          { mode: 0o755 },
        ),
      );
      const clockFile = join(directory, "clock");
      yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.writeFileString(clockFile, "0"),
      );
      yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.writeFileString(join(directory, "date"), '#!/bin/sh\ncat "$CLOCK_FILE"\n', {
          mode: 0o755,
        }),
      );
      const ownerFile = join(directory, "owner");
      yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.writeFileString(ownerFile, "0"),
      );
      yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.writeFileString(
          join(directory, "stat"),
          '#!/bin/sh\n[ "$1" = -c ] && [ "$2" = %u ] && [ "$3" = "$STORE" ]\ncat "$OWNER_FILE"\n',
          { mode: 0o755 },
        ),
      );
      const prepare = (uid = imageUid, failStage = "none") =>
        run(
          "sh",
          ["-c", PREPARE_CACHE_SCRIPT, "sh", runtimeName, "image", volume, "mount", store],
          {
            env: {
              PATH: `${directory}:${environmentPATH1}`,
              STORE: store,
              RUNTIME_NAME: runtimeName,
              IMAGE_UID: uid,
              OWNER_FILE: ownerFile,
              CLOCK_FILE: clockFile,
              FAIL_STAGE: failStage,
            },
          },
        );

      yield* Effect.promise(() =>
        assert.rejects(prepare(imageUid, "volume"), /volume create failed/u),
      );
      const missingStore = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.stat(store),
      ).pipe(Effect.flip);
      assert.match(String(missingStore.reason.cause), /ENOENT/u);
      const first = yield* Effect.promise(() => prepare());
      assert.strictEqual(first.stdout, "37\n", "the run duration excludes volume creation");
      assert.strictEqual(
        (yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.readFileString(ownerFile),
        )).trim(),
        imageUid,
      );
      assert.strictEqual(
        (yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.stat(store)))
          .mode & 0o777,
        0o755,
      );
      yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.makeDirectory(join(store, "v11")),
      );
      yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.writeFileString(join(store, "v11", "package"), "cached package"),
      );
      for (const timestamp of ["1793637391N", "17936373913N", ""]) {
        yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.writeFileString(join(directory, "date"), `#!/bin/sh\necho '${timestamp}'\n`, {
            mode: 0o755,
          }),
        );
        const prepared = yield* Effect.promise(() => prepare());
        assert.strictEqual(prepared.stdout, `${timestamp}:${timestamp}\n`);
        assert.strictEqual(prepared.stderr, "");
      }
      yield* Effect.promise(() => Promise.all([prepare(), prepare()]));
      yield* Effect.promise(() =>
        assert.rejects(prepare("7001"), new RegExp(`${runtimeName} volume rm ${volume}`, "u")),
      );
      assert.strictEqual(
        (yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.readFileString(ownerFile),
        )).trim(),
        imageUid,
      );
      yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.writeFileString(ownerFile, "0"),
      );
      yield* Effect.promise(() =>
        assert.rejects(prepare(), new RegExp(`${runtimeName} volume rm ${volume}`, "u")),
      );
      const actual1 = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.readFileString(join(store, "v11", "package")),
      );
      assert.strictEqual(actual1, "cached package");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
);

import { assert, describe, it } from "@effect/vitest";
import { MinFreeDiskGib } from "@usine/core/worker";
import { Effect, Fiber, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { reportsDiskFull } from "../../src/disk-full.ts";
import { Executor, ExecutorOperationError, WorkerCapabilityError } from "../../src/executor.ts";
import { freeSpaceFromDf } from "../../src/ssh/disk.ts";
import { imageRepository, oldWorkerImages, workerImagesFromList } from "../../src/ssh/image.ts";
import { ATTEMPT_IMAGE } from "../../src/ssh/ssh.ts";
import {
  ADDRESS,
  capturedLogs,
  executorLayer,
  fakeMachine,
  mintingProvider,
  noGateway,
  request,
  runtime,
  WORKER,
} from "./support.ts";

const REPOSITORY = imageRepository(ATTEMPT_IMAGE);

const linesOf = (machine: ReturnType<typeof fakeMachine>) =>
  machine.state.calls.map(({ line }) => line);

const withThreshold = (machine: ReturnType<typeof fakeMachine>, gib: number) =>
  executorLayer(machine, mintingProvider(), {
    ...ADDRESS,
    minFreeDiskGib: MinFreeDiskGib.make(gib),
  }).pipe(Layer.provide(noGateway));

describe("free disk space of an SSH Worker", () => {
  it.effect("fails preflight with the free space and the default threshold", () => {
    const machine = fakeMachine();
    machine.state.freeDiskGib = 3.5;
    return Effect.gen(function* () {
      const executor = yield* Executor;
      const error = yield* executor.preflight(WORKER, [], 1).pipe(Effect.flip);
      assert(error._tag === "WorkerCapabilityError");
      assert.strictEqual(error.capability, "disk");
      assert.include(
        error.message,
        "has 3.5 GiB free on /srv/usine, below its threshold of 10 GiB",
      );
      assert.include(error.message, "min_free_disk_gib");
    }).pipe(Effect.provide(runtime(machine, mintingProvider())));
  });

  it.effect.each([
    { storageGib: 1.5, passes: false },
    { storageGib: 3, passes: true },
  ])(
    "checks the image storage of the container runtime against min_free_disk_gib: $storageGib GiB",
    ({ storageGib, passes }) => {
      const machine = fakeMachine();
      machine.state.docker = "running";
      machine.state.storageFreeDiskGib = storageGib;
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const result = yield* executor.preflight(WORKER, [], 1).pipe(Effect.result);
        if (passes) return assert.strictEqual(result._tag, "Success");
        assert(result._tag === "Failure" && result.failure._tag === "WorkerCapabilityError");
        assert.strictEqual(result.failure.capability, "disk");
        assert.include(
          result.failure.message,
          "has 1.5 GiB free on /var/lib/docker, below its threshold of 2 GiB",
        );
      }).pipe(Effect.scoped, Effect.provide(withThreshold(machine, 2)));
    },
  );

  it.effect("checks the free disk space before a checkout starts", () => {
    const machine = fakeMachine();
    machine.state.freeDiskGib = 1;
    return Effect.gen(function* () {
      const executor = yield* Executor;
      const error = yield* executor.prepare(request).pipe(Effect.scoped, Effect.flip);
      assert(error._tag === "WorkerCapabilityError");
      assert.strictEqual(error.capability, "disk");
      assert.include(
        error.message,
        "has 1.0 GiB free on /srv/usine, below its threshold of 10 GiB",
      );
      assert.isFalse(linesOf(machine).some((line) => line.includes("'git' 'clone'")));
    }).pipe(Effect.provide(runtime(machine, mintingProvider())));
  });

  it.effect("checks Docker image storage before preparing a checkout", () => {
    const machine = fakeMachine();
    machine.state.docker = "running";
    machine.state.storageFreeDiskGib = 1;
    return Effect.gen(function* () {
      const executor = yield* Executor;
      const error = yield* executor.prepare(request).pipe(Effect.scoped, Effect.flip);
      assert(error._tag === "WorkerCapabilityError");
      assert.strictEqual(error.capability, "disk");
      assert.include(error.message, "has 1.0 GiB free on /var/lib/docker");
      assert.isFalse(linesOf(machine).some((line) => line.includes("'git' 'clone'")));
    }).pipe(Effect.provide(runtime(machine, mintingProvider())));
  });

  it.effect.each(["preflight", "prepare"] as const)(
    "disables disk probes during %s when min_free_disk_gib is zero",
    (operation) => {
      const machine = fakeMachine();
      machine.state.docker = "running";
      machine.state.diskReadError = "df: cannot read filesystem";
      machine.state.storageFreeDiskGib = 0;
      const logs = capturedLogs();
      return Effect.gen(function* () {
        const executor = yield* Executor;
        if (operation === "preflight") yield* executor.preflight(WORKER, [], 1);
        else yield* executor.prepare(request);
        assert.isFalse(linesOf(machine).some((line) => line.includes("df -Pk")));
        assert.isTrue(
          logs.infos.some((line) => line.includes("free disk space check is disabled")),
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(withThreshold(machine, 0).pipe(Layer.provideMerge(logs.layer))),
      );
    },
  );

  it.effect.each(["info-fails", "info-empty", "df-fails"] as const)(
    "logs skipped image storage checks at Info when %s",
    (failure) => {
      const machine = fakeMachine();
      machine.state.docker = "running";
      machine.state.storageProbe = failure;
      const logs = capturedLogs();
      return Effect.gen(function* () {
        const executor = yield* Executor;
        yield* executor.preflight(WORKER, [], 1);
        const skipped = logs.infos.find((line) =>
          line.includes("Skipped SSH Worker image storage disk check"),
        );
        assert.isDefined(skipped);
        assert.include(
          skipped ?? "",
          failure === "df-fails" ? "/var/lib/docker" : "docker did not report",
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(runtime(machine, mintingProvider()).pipe(Layer.provideMerge(logs.layer))),
      );
    },
  );

  it.effect("reports an image pull that runs out of disk space during preflight", () => {
    const machine = fakeMachine();
    machine.state.docker = "running";
    machine.state.imageOnMachine = false;
    machine.state.pullError = "write /var/lib/docker/tmp/image: no space left on device";
    return Effect.gen(function* () {
      const executor = yield* Executor;
      const checking = yield* executor.preflight(WORKER, [], 1).pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("20 seconds");
      const error = yield* Fiber.join(checking);
      assert(error._tag === "WorkerCapabilityError");
      assert.strictEqual(error.capability, "disk");
      assert.include(error.message, `Worker "${WORKER}" ran out of disk space`);
    }).pipe(Effect.scoped, Effect.provide(runtime(machine, mintingProvider())));
  });

  it.effect("reports a checkout that runs out of disk space as a disk capability error", () => {
    const machine = fakeMachine();
    machine.state.cacheExists = false;
    machine.state.cloneError = "fatal: write error: No space left on device";
    const logs = capturedLogs();
    return Effect.gen(function* () {
      const executor = yield* Executor;
      const error = yield* executor.prepare(request).pipe(Effect.scoped, Effect.flip);
      assert(error._tag === "WorkerCapabilityError");
      assert.strictEqual(error.capability, "disk");
      assert.include(error.message, `Worker "${WORKER}" ran out of disk space`);
      assert.isTrue(
        logs.warnings.some((line) => line.includes("A worker command ran out of disk space")),
      );
    }).pipe(
      Effect.provide(runtime(machine, mintingProvider()).pipe(Layer.provideMerge(logs.layer))),
    );
  });

  it("parses df output once per mount point", () => {
    assert.deepStrictEqual(
      freeSpaceFromDf(
        [
          "Filesystem     1024-blocks      Used Available Capacity Mounted on",
          "/dev/sda1         78643200  72000000   6643200      92% /",
          "overlay           78643200  72000000   6643200      92% /",
          "/dev/sdb1        104857600   1048576 103809024       1% /var/lib/docker",
          "",
        ].join("\n"),
      ),
      [
        { mount: "/", availableBytes: 6643200 * 1024 },
        { mount: "/var/lib/docker", availableBytes: 103809024 * 1024 },
      ],
    );
  });
});

describe("older worker images on an SSH Worker", () => {
  it("names the repository of an image without its tag or digest", () => {
    assert.strictEqual(imageRepository("ghcr.io/acme/worker:1.2"), "ghcr.io/acme/worker");
    assert.strictEqual(imageRepository("localhost:5000/worker"), "localhost:5000/worker");
    assert.strictEqual(imageRepository("localhost:5000/worker:3"), "localhost:5000/worker");
    assert.strictEqual(
      imageRepository("ghcr.io/acme/worker:1.2@sha256:0123"),
      "ghcr.io/acme/worker",
    );
  });

  it("reads Docker's and Podman's creation times and keeps only the repository's images", () => {
    const images = workerImagesFromList(
      [
        "sha256:aa ghcr.io/acme/worker 2 2026-11-12 10:00:00 +0100 CET",
        "sha256:bb ghcr.io/acme/worker <none> 2026-11-10 09:00:00.123456789 +0000 UTC",
        "sha256:cc ghcr.io/acme/other 1 2026-11-12 10:00:00 +0000 UTC",
        "",
      ].join("\n"),
      "ghcr.io/acme/worker",
    );
    assert.deepStrictEqual(
      images,
      Option.some([
        {
          id: "aa",
          reference: Option.some("ghcr.io/acme/worker:2"),
          createdAt: Date.parse("2026-11-12T09:00:00Z"),
        },
        { id: "bb", reference: Option.none(), createdAt: Date.parse("2026-11-10T09:00:00Z") },
      ]),
    );
    assert.isTrue(
      Option.isNone(
        workerImagesFromList("sha256:aa ghcr.io/acme/worker 2 2 days ago", "ghcr.io/acme/worker"),
      ),
    );
  });

  it("keeps the current image, the newest other one, and those a container uses", () => {
    const image = (id: string, tag: string | undefined, day: number) => ({
      id,
      reference: Option.map(Option.fromUndefinedOr(tag), (tag) => `ghcr.io/acme/worker:${tag}`),
      createdAt: Date.UTC(2026, 10, day),
    });
    assert.deepStrictEqual(
      oldWorkerImages(
        [
          image("old", "1", 1),
          image("current", "3", 3),
          image("previous", "2", 2),
          image("used", "0", 0),
          image("untagged", undefined, 1),
          image("twice", "a", 1),
          image("twice", "b", 1),
        ],
        "sha256:current",
        new Set(["sha256:used"]),
      ),
      {
        previous: Option.some("previous"),
        inUse: ["used"],
        remove: [
          "ghcr.io/acme/worker:1",
          "untagged",
          "ghcr.io/acme/worker:a",
          "ghcr.io/acme/worker:b",
        ],
      },
    );
  });

  it.effect.each(["imageListError", "containerListError", "imageRemovalError"] as const)(
    "logs %s without failing preflight or deleting images",
    (failure) => {
      const machine = fakeMachine();
      machine.state.docker = "running";
      machine.state.pulledImageId = "sha256:c0";
      machine.state.workerImages = [
        `sha256:c0 ${REPOSITORY} current 2026-11-13 08:00:00 +0000 UTC`,
        `sha256:b0 ${REPOSITORY} previous 2026-11-12 08:00:00 +0000 UTC`,
        `sha256:a0 ${REPOSITORY} older 2026-11-11 08:00:00 +0000 UTC`,
      ];
      const images = [...machine.state.workerImages];
      machine.state[failure] =
        failure === "imageRemovalError"
          ? "conflict: image is being used by a running container"
          : "runtime refused listing";
      const logs = capturedLogs();
      return Effect.gen(function* () {
        const executor = yield* Executor;
        yield* executor.preflight(WORKER, [], 1);
        assert.deepStrictEqual(machine.state.workerImages, images);
        assert.isTrue(
          logs.warnings.some((line) =>
            line.includes(
              failure === "imageRemovalError"
                ? "Could not remove some older worker images"
                : "Could not remove older worker images",
            ),
          ),
        );
        assert.lengthOf(machine.state.imageRemovals, failure === "imageRemovalError" ? 1 : 0);
      }).pipe(
        Effect.scoped,
        Effect.provide(runtime(machine, mintingProvider()).pipe(Layer.provideMerge(logs.layer))),
      );
    },
  );

  it.effect("logs at Info when the runtime lists no matching worker images", () => {
    const machine = fakeMachine();
    machine.state.docker = "running";
    machine.state.workerImages = [
      "sha256:a0 ghcr.io/acme/other latest 2026-11-11 08:00:00 +0000 UTC",
    ];
    const logs = capturedLogs();
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(WORKER, [], 1);
      const skipped = logs.infos.find((line) => line.includes("No older worker image to remove"));
      assert.isDefined(skipped);
      assert.include(skipped ?? "", '"images":0');
      assert.lengthOf(machine.state.imageRemovals, 0);
    }).pipe(
      Effect.scoped,
      Effect.provide(runtime(machine, mintingProvider()).pipe(Layer.provideMerge(logs.layer))),
    );
  });

  it.effect(
    "removes older worker images after a pull and keeps the current, the previous, and those in use",
    () => {
      const machine = fakeMachine();
      machine.state.docker = "running";
      machine.state.pulledImageId = "sha256:c0";
      machine.state.workerImages = [
        `sha256:c0 ${REPOSITORY} current 2026-11-13 08:00:00 +0000 UTC`,
        `sha256:b0 ${REPOSITORY} previous 2026-11-12 08:00:00 +0000 UTC`,
        `sha256:a1 ${REPOSITORY} older 2026-11-11 08:00:00 +0000 UTC`,
        `sha256:a2 ${REPOSITORY} used 2026-11-10 08:00:00 +0000 UTC`,
        `sha256:a3 ${REPOSITORY} <none> 2026-11-09 08:00:00 +0000 UTC`,
      ];
      machine.state.containerImageIds = ["sha256:a2"];
      const logs = capturedLogs();
      return Effect.gen(function* () {
        const executor = yield* Executor;
        yield* executor.preflight(WORKER, [], 1);
        assert.deepStrictEqual(machine.state.imageRemovals, [[`${REPOSITORY}:older`, "a3"]]);
        assert.deepStrictEqual(
          machine.state.workerImages.map((line) => line.split(" ")[0]),
          ["sha256:c0", "sha256:b0", "sha256:a2"],
        );
        assert.isTrue(logs.lines.some((line) => line.includes("Removed older worker images")));
      }).pipe(
        Effect.scoped,
        Effect.provide(runtime(machine, mintingProvider()).pipe(Layer.provideMerge(logs.layer))),
      );
    },
  );
});

describe("disk-full reports", () => {
  it("finds ENOSPC in an error's causes", () => {
    assert.isTrue(
      reportsDiskFull(
        ExecutorOperationError.make({
          operation: "prepare",
          message: "ssh exited with code 128",
          cause: new Error("fatal: write error: No space left on device"),
        }),
      ),
    );
    assert.isTrue(
      reportsDiskFull(
        WorkerCapabilityError.make({
          worker: WORKER,
          capability: "container",
          message: "Can't pull",
          cause: new Error("write /var/lib/docker/tmp/x: no space left on device"),
        }),
      ),
    );
    const failed = (stderr: string) =>
      ExecutorOperationError.make({
        operation: "prepare",
        message: "ssh exited with code 1",
        cause: stderr,
      });
    assert.isTrue(reportsDiskFull(failed("npm ERR! code ENOSPC")));
    assert.isFalse(reportsDiskFull(failed("fatal: Authentication failed")));
  });
});

import { jsonKey } from "@usine/core/json-key";
import { NodeFileSystem } from "@effect/platform-node";
import { tmpdir } from "node:os";
// Synchronous Node path callbacks retain the host platform’s path semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join, dirname, basename } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { RepositoryName } from "@usine/core/repository";
import { DateTime, Effect, Layer, Redacted, FileSystem } from "effect";
import { TestClock } from "effect/testing";
import { Attachment, InstallationCredential } from "../src/attachment/attachment.ts";
import { Attachments } from "../src/attachment/store.ts";
import { fileAttachmentsLayer } from "../src/node/attachments.ts";
import {
  ATTACHMENT,
  OTHER_ATTACHMENT,
  NO_PROVIDERS,
  REPOSITORY,
  WORKER,
  settingsLayer,
} from "./fixtures.ts";

const START = DateTime.makeUnsafe("2026-10-28T20:00:00Z");
const TOKEN = "ghs_persistence-regression-secret";
const attachment = (id = ATTACHMENT, minutes = 60, token = TOKEN) =>
  Attachment.make({
    id,
    worker: WORKER,
    repository: REPOSITORY,
    credential: InstallationCredential.make({ token: Redacted.make(token) }),
    expiresAt: DateTime.add(START, { minutes }),
  });

const directory = Effect.acquireRelease(
  Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
    fileSystem.makeTempDirectory({
      directory: dirname(join(tmpdir(), "gateway-attachments-")),
      prefix: basename(join(tmpdir(), "gateway-attachments-")),
    }),
  ),
  (path) =>
    Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
      fileSystem.remove(path, { recursive: true, force: true }),
    ).pipe(Effect.orDie),
);
const persisted = (path: string) =>
  fileAttachmentsLayer(path).pipe(Layer.provide(settingsLayer(NO_PROVIDERS)));

describe("encrypted attachments", () => {
  it.effect(
    "restores concurrent attachments, renewed credentials and learned names, but not detach or expiry",
    () =>
      Effect.gen(function* () {
        const path = yield* directory;
        yield* TestClock.setTime(DateTime.toEpochMillis(START));
        yield* Effect.gen(function* () {
          const store = yield* Attachments;
          yield* Effect.all(
            [store.attach(attachment()), store.attach(attachment(OTHER_ATTACHMENT, 2))],
            { concurrency: "unbounded" },
          );
          yield* store.attach(attachment(ATTACHMENT, 120, `${TOKEN}-renewed`));
          yield* store.learnNewName(ATTACHMENT, RepositoryName.make("acme/renamed"));
        }).pipe(Effect.provide(persisted(path)));
        const bytes = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.readFile(join(path, "attachments.enc")).pipe(Effect.map(Buffer.from)),
        );
        assert.isFalse(bytes.includes(TOKEN));
        assert.strictEqual(
          (yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
            fileSystem.stat(join(path, "attachments.enc")),
          )).mode & 511,
          384,
        );
        yield* Effect.gen(function* () {
          const store = yield* Attachments;
          assert.strictEqual((yield* store.list).length, 2);
          const found = yield* store.find(ATTACHMENT);
          assert(found._tag === "LiveAttachment");
          assert.isTrue(found.serves(RepositoryName.make("acme/renamed")));
          assert(found.attachment.credential._tag === "InstallationCredential");
          assert.strictEqual(Redacted.value(found.attachment.credential.token), `${TOKEN}-renewed`);
          const detached = yield* store.detach(ATTACHMENT);
          assert.isTrue(detached);
        }).pipe(Effect.provide(persisted(path)));
        yield* TestClock.adjust("3 minutes");
        yield* Effect.gen(function* () {
          const store = yield* Attachments;
          const currentList = yield* store.list;
          assert.deepStrictEqual(currentList, []);
          assert.strictEqual((yield* store.find(ATTACHMENT))._tag, "MissingAttachment");
          assert.strictEqual((yield* store.find(OTHER_ATTACHMENT))._tag, "MissingAttachment");
        }).pipe(Effect.provide(persisted(path)));
      }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("a failed write neither changes the live credential nor acknowledges a detach", () =>
    Effect.gen(function* () {
      const path = yield* directory;
      const state = join(path, "state");
      yield* TestClock.setTime(DateTime.toEpochMillis(START));
      yield* Effect.gen(function* () {
        const store = yield* Attachments;
        yield* store.attach(attachment());
        {
          yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
            fileSystem.rename(state, `${state}-saved`),
          );
          yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
            fileSystem.writeFileString(state, "not a directory"),
          );
        }
        const failedRenewal = yield* store
          .attach(attachment(ATTACHMENT, 120, "replacement-secret"))
          .pipe(Effect.flip);
        assert.strictEqual(failedRenewal._tag, "AttachmentPersistenceError");
        const json1 = jsonKey(failedRenewal);
        assert.notInclude(json1, TOKEN);
        const failedDetach = yield* store.detach(ATTACHMENT).pipe(Effect.flip);
        assert.strictEqual(failedDetach._tag, "AttachmentPersistenceError");
        const found = yield* store.find(ATTACHMENT);
        assert(
          found._tag === "LiveAttachment" &&
            found.attachment.credential._tag === "InstallationCredential",
        );
        assert.strictEqual(Redacted.value(found.attachment.credential.token), TOKEN);
        {
          yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.remove(state));
          yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
            fileSystem.rename(`${state}-saved`, state),
          );
        }
      }).pipe(Effect.provide(persisted(state)));
      yield* Effect.gen(function* () {
        const found = yield* (yield* Attachments).find(ATTACHMENT);
        assert(
          found._tag === "LiveAttachment" &&
            found.attachment.credential._tag === "InstallationCredential",
        );
        assert.strictEqual(Redacted.value(found.attachment.credential.token), TOKEN);
      }).pipe(Effect.provide(persisted(state)));
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.effect(
    "refuses a corrupt snapshot or changed caller key without replacing the saved state",
    () =>
      Effect.gen(function* () {
        const path = yield* directory;
        yield* TestClock.setTime(DateTime.toEpochMillis(START));
        yield* Effect.flatMap(Attachments, (store) => store.attach(attachment())).pipe(
          Effect.provide(persisted(path)),
        );
        const snapshot = join(path, "attachments.enc");
        const original = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.readFile(snapshot).pipe(Effect.map(Buffer.from)),
        );
        const wrongKey = fileAttachmentsLayer(path).pipe(
          Layer.provide(settingsLayer(NO_PROVIDERS, "changed-caller-key-01234567890123456789")),
        );
        const error = yield* Effect.void.pipe(Effect.provide(wrongKey), Effect.flip);
        assert.strictEqual(error._tag, "AttachmentPersistenceError");
        const responseBody = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.readFile(snapshot).pipe(Effect.map(Buffer.from)),
        );
        assert.deepStrictEqual(responseBody, original);
        for (const bytes of [
          Buffer.alloc(0),
          Buffer.from("invalid snapshot"),
          Buffer.from(original).fill(original.readUInt8(28) ^ 1, 28, 29),
        ]) {
          yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
            fileSystem.writeFile(snapshot, bytes),
          );
          const corrupt = yield* Effect.void.pipe(Effect.provide(persisted(path)), Effect.flip);
          assert.strictEqual(corrupt._tag, "AttachmentPersistenceError");
          const currentResponseBody = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
            fileSystem.readFile(snapshot).pipe(Effect.map(Buffer.from)),
          );
          assert.deepStrictEqual(currentResponseBody, bytes);
        }
      }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );
});

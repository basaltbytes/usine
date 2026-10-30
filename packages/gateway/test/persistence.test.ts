import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { RepositoryName } from "@usine/core/repository";
import { DateTime, Effect, Layer, Redacted } from "effect";
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
  new Attachment({
    id,
    worker: WORKER,
    repository: REPOSITORY,
    credential: new InstallationCredential({ token: Redacted.make(token) }),
    expiresAt: DateTime.add(START, { minutes }),
  });

const directory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "gateway-attachments-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
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
        const bytes = yield* Effect.promise(() => readFile(join(path, "attachments.enc")));
        assert.isFalse(bytes.includes(TOKEN));
        assert.strictEqual(
          (yield* Effect.promise(() => stat(join(path, "attachments.enc")))).mode & 0o777,
          0o600,
        );
        yield* Effect.gen(function* () {
          const store = yield* Attachments;
          assert.strictEqual((yield* store.list()).length, 2);
          const found = yield* store.find(ATTACHMENT);
          assert(found._tag === "LiveAttachment");
          assert.isTrue(found.serves(RepositoryName.make("acme/renamed")));
          assert(found.attachment.credential._tag === "InstallationCredential");
          assert.strictEqual(Redacted.value(found.attachment.credential.token), `${TOKEN}-renewed`);
          assert.isTrue(yield* store.detach(ATTACHMENT));
        }).pipe(Effect.provide(persisted(path)));
        yield* TestClock.adjust("3 minutes");
        yield* Effect.gen(function* () {
          const store = yield* Attachments;
          assert.deepStrictEqual(yield* store.list(), []);
          assert.strictEqual((yield* store.find(ATTACHMENT))._tag, "MissingAttachment");
          assert.strictEqual((yield* store.find(OTHER_ATTACHMENT))._tag, "MissingAttachment");
        }).pipe(Effect.provide(persisted(path)));
      }).pipe(Effect.scoped),
  );

  it.effect("a failed write neither changes the live credential nor acknowledges a detach", () =>
    Effect.gen(function* () {
      const path = yield* directory;
      const state = join(path, "state");
      yield* TestClock.setTime(DateTime.toEpochMillis(START));
      yield* Effect.gen(function* () {
        const store = yield* Attachments;
        yield* store.attach(attachment());
        yield* Effect.promise(async () => {
          await rename(state, `${state}-saved`);
          await writeFile(state, "not a directory");
        });
        const failedRenewal = yield* store
          .attach(attachment(ATTACHMENT, 120, "replacement-secret"))
          .pipe(Effect.flip);
        assert.strictEqual(failedRenewal._tag, "AttachmentPersistenceError");
        assert.notInclude(JSON.stringify(failedRenewal), TOKEN);
        const failedDetach = yield* store.detach(ATTACHMENT).pipe(Effect.flip);
        assert.strictEqual(failedDetach._tag, "AttachmentPersistenceError");
        const found = yield* store.find(ATTACHMENT);
        assert(
          found._tag === "LiveAttachment" &&
            found.attachment.credential._tag === "InstallationCredential",
        );
        assert.strictEqual(Redacted.value(found.attachment.credential.token), TOKEN);
        yield* Effect.promise(async () => {
          await rm(state);
          await rename(`${state}-saved`, state);
        });
      }).pipe(Effect.provide(persisted(state)));
      yield* Effect.gen(function* () {
        const found = yield* (yield* Attachments).find(ATTACHMENT);
        assert(
          found._tag === "LiveAttachment" &&
            found.attachment.credential._tag === "InstallationCredential",
        );
        assert.strictEqual(Redacted.value(found.attachment.credential.token), TOKEN);
      }).pipe(Effect.provide(persisted(state)));
    }).pipe(Effect.scoped),
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
        const original = yield* Effect.promise(() => readFile(snapshot));
        const wrongKey = fileAttachmentsLayer(path).pipe(
          Layer.provide(settingsLayer(NO_PROVIDERS, "changed-caller-key-01234567890123456789")),
        );
        const error = yield* Effect.void.pipe(Effect.provide(wrongKey), Effect.flip);
        assert.strictEqual(error._tag, "AttachmentPersistenceError");
        assert.deepStrictEqual(yield* Effect.promise(() => readFile(snapshot)), original);
        for (const bytes of [
          Buffer.alloc(0),
          Buffer.from("invalid snapshot"),
          Buffer.from(original).fill(original.readUInt8(28) ^ 1, 28, 29),
        ]) {
          yield* Effect.promise(() => writeFile(snapshot, bytes));
          const corrupt = yield* Effect.void.pipe(Effect.provide(persisted(path)), Effect.flip);
          assert.strictEqual(corrupt._tag, "AttachmentPersistenceError");
          assert.deepStrictEqual(yield* Effect.promise(() => readFile(snapshot)), bytes);
        }
      }).pipe(Effect.scoped),
  );
});

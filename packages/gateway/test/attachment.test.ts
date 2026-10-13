import { assert, describe, it } from "@effect/vitest";
import { RepositoryName } from "@usine/core/repository";
import { DateTime, Effect, Redacted } from "effect";
import { TestClock } from "effect/testing";
import {
  Attachment,
  type AttachmentId,
  InstallationCredential,
} from "../src/attachment/attachment.ts";
import { Attachments } from "../src/attachment/store.ts";
import {
  ATTACHMENT,
  OTHER_ATTACHMENT,
  OTHER_REPOSITORY,
  REPOSITORY,
  WORKER,
  secret,
} from "./fixtures.ts";

const START = DateTime.makeUnsafe("2026-10-13T10:00:00Z");

const attachment = (id: AttachmentId, token: string, minutes: number) =>
  new Attachment({
    id,
    worker: WORKER,
    repository: REPOSITORY,
    credential: new InstallationCredential({ token: secret(token) }),
    expiresAt: DateTime.add(START, { minutes }),
  });

/** Sets the clock before the store starts, so its sweep timer starts from the test's time. */
const at = <A, E>(time: DateTime.Utc, body: Effect.Effect<A, E, Attachments>) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DateTime.toEpochMillis(time));
    return yield* body.pipe(Effect.provide(Attachments.layer));
  });

const tokenOf = (lookup: Effect.Success<ReturnType<Attachments["Service"]["find"]>>) => {
  assert(lookup._tag === "LiveAttachment", `expected a live attachment, got ${lookup._tag}`);
  const credential = lookup.attachment.credential;
  assert(credential._tag === "InstallationCredential");
  return Redacted.value(credential.token);
};

describe("Attachments", () => {
  it.effect(
    "a renewal under the same id replaces the token, so the gateway never sends the stale one",
    () =>
      at(
        START,
        Effect.gen(function* () {
          const attachments = yield* Attachments;
          yield* attachments.attach(attachment(ATTACHMENT, "ghs_first", 60));
          yield* attachments.attach(attachment(ATTACHMENT, "ghs_second", 120));
          assert.strictEqual(tokenOf(yield* attachments.find(ATTACHMENT)), "ghs_second");
          assert.strictEqual((yield* attachments.list()).length, 1);
        }),
      ),
  );

  it.effect("two Attempts on one Worker for one repository keep separate attachments", () =>
    at(
      START,
      Effect.gen(function* () {
        const attachments = yield* Attachments;
        yield* attachments.attach(attachment(ATTACHMENT, "ghs_first", 60));
        yield* attachments.attach(attachment(OTHER_ATTACHMENT, "ghs_second", 60));
        assert.isTrue(yield* attachments.detach(ATTACHMENT));
        assert.isFalse(yield* attachments.detach(ATTACHMENT));
        assert.strictEqual((yield* attachments.find(ATTACHMENT))._tag, "MissingAttachment");
        assert.strictEqual(tokenOf(yield* attachments.find(OTHER_ATTACHMENT)), "ghs_second");
      }),
    ),
  );

  it.effect("an attachment stops granting access when its token expires", () =>
    at(
      START,
      Effect.gen(function* () {
        const attachments = yield* Attachments;
        yield* attachments.attach(
          new Attachment({
            ...attachment(ATTACHMENT, "ghs_token", 60),
            expiresAt: DateTime.add(START, { minutes: 60, seconds: 30 }),
          }),
        );
        yield* TestClock.adjust("60 minutes");
        assert.strictEqual((yield* attachments.find(ATTACHMENT))._tag, "LiveAttachment");
        yield* TestClock.adjust("45 seconds");
        assert.strictEqual((yield* attachments.find(ATTACHMENT))._tag, "ExpiredAttachment");
        assert.deepStrictEqual(yield* attachments.list(), []);
        // The sweep at the next whole minute forgets it.
        yield* TestClock.adjust("15 seconds");
        assert.strictEqual((yield* attachments.find(ATTACHMENT))._tag, "MissingAttachment");
      }),
    ),
  );

  it.effect("an already expired token is refused instead of stored", () =>
    at(
      DateTime.add(START, { hours: 2 }),
      Effect.gen(function* () {
        const attachments = yield* Attachments;
        const error = yield* Effect.flip(
          attachments.attach(attachment(ATTACHMENT, "ghs_token", 60)),
        );
        assert.strictEqual(error._tag, "AttachmentAlreadyExpired");
        assert.strictEqual((yield* attachments.find(ATTACHMENT))._tag, "MissingAttachment");
      }),
    ),
  );

  it.effect("a renewal cannot move an attachment id to another repository", () =>
    at(
      START,
      Effect.gen(function* () {
        const attachments = yield* Attachments;
        yield* attachments.attach(attachment(ATTACHMENT, "ghs_token", 60));
        yield* attachments.attach(
          new Attachment({
            ...attachment(ATTACHMENT, "ghs_renewed", 60),
            repository: RepositoryName.make("ACME/Demo"),
          }),
        );
        const error = yield* Effect.flip(
          attachments.attach(
            new Attachment({
              ...attachment(ATTACHMENT, "ghs_moved", 60),
              repository: OTHER_REPOSITORY,
            }),
          ),
        );
        assert.strictEqual(error._tag, "AttachmentConflict");
        assert.strictEqual(tokenOf(yield* attachments.find(ATTACHMENT)), "ghs_renewed");
      }),
    ),
  );
});

import { InstanceDirectory } from "@usine/core/instance";
import { Effect, FileSystem, Option, Redacted, Schema } from "effect";
import { authFailure } from "./model.ts";
import { randomSecret } from "./crypto.ts";

const file = (directory: InstanceDirectory) => `${directory}/.usine/admin-token`;
const Secret = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u));
export const readAdminToken = Effect.fn("Authentication.readAdminToken")(function* (
  directory: InstanceDirectory,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = file(directory);
  const owner = process.getuid?.();
  const failure = (reason: string) =>
    authFailure(
      `${reason}: ${path}. Expected a regular file owned by uid ${owner ?? "of the current user"} with mode 0600, without a symbolic link.`,
      503,
    );
  yield* Effect.annotateCurrentSpan({ path });
  const info = yield* fs
    .lstat(path)
    .pipe(Effect.mapError(() => failure("Could not inspect the local admin token")));
  if (
    info.type !== "File" ||
    (info.mode & 0o7777) !== 0o600 ||
    !Option.exists(info.uid, (uid) => uid === owner)
  )
    return yield* failure("Unsafe local admin token");
  const raw = yield* fs
    .readFileString(path)
    .pipe(Effect.mapError(() => failure("Could not read the local admin token")));
  const token = yield* Schema.decodeUnknownEffect(Secret)(raw.trim()).pipe(
    Effect.mapError(() => failure("Invalid local admin token; restart usine up")),
  );
  return Redacted.make(token);
});
export const writeAdminToken = Effect.fn("Authentication.writeAdminToken")(function* (
  directory: InstanceDirectory,
) {
  const fs = yield* FileSystem.FileSystem;
  const token = randomSecret();
  const temporary = `${file(directory)}.${crypto.randomUUID()}`;
  yield* fs.writeFileString(temporary, Redacted.value(token), { mode: 0o600, flag: "wx" }).pipe(
    Effect.andThen(fs.rename(temporary, file(directory))),
    Effect.mapError(() => authFailure("Could not write the local admin token.", 503)),
  );
  yield* Effect.logInfo("Local admin token written", { directory });
  return token;
});

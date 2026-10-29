import { InstanceDirectory } from "@usine/core/instance";
import { Effect, FileSystem, Redacted, Schema } from "effect";
import { authFailure } from "./model.ts";
import { randomSecret } from "./crypto.ts";

const file = (directory: InstanceDirectory) => `${directory}/.usine/admin-token`;
const Secret = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u));
export const readAdminToken = Effect.fn("Authentication.readAdminToken")(function* (
  directory: InstanceDirectory,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = file(directory);
  const info = yield* fs
    .stat(path)
    .pipe(
      Effect.mapError(() =>
        authFailure("The local admin token is missing. Start usine up first.", 503),
      ),
    );
  if (info.type !== "File" || (info.mode & 0o777) !== 0o600)
    return yield* authFailure("The local admin token must have mode 0600.", 503);
  const raw = yield* fs
    .readFileString(path)
    .pipe(Effect.mapError(() => authFailure("Could not read the local admin token.", 503)));
  const token = yield* Schema.decodeUnknownEffect(Secret)(raw.trim()).pipe(
    Effect.mapError(() => authFailure("The local admin token is invalid. Restart usine up.", 503)),
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

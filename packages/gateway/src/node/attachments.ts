import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Exit, FileSystem, Layer, Option, Redacted, Schema } from "effect";
import { AttachmentPersistenceError, LiveAttachment } from "../attachment/attachment.ts";
import { Attachments, type AttachmentPersistence } from "../attachment/store.ts";
import { GatewaySettings } from "../settings.ts";

const Snapshot = Schema.fromJsonString(
  Schema.toCodecJson(
    Schema.Struct({
      version: Schema.Literal(1),
      entries: Schema.Array(LiveAttachment),
    }),
  ),
);
const encode = Schema.encodeSync(Snapshot);
const decode = Schema.decodeUnknownEffect(Snapshot, { onExcessProperty: "error" });

/** Stores AES-256-GCM snapshots in `directory`, encrypted with a purpose-specific derivation of the caller key. */
export const fileAttachmentsLayer = (directory: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { callerKey } = yield* GatewaySettings;
      const path = join(directory, "attachments.enc");
      const key = createHash("sha256")
        .update("usine-gateway-attachments-v1\0")
        .update(Redacted.value(callerKey))
        .digest();
      const failure = (operation: "read" | "write") =>
        new AttachmentPersistenceError({
          operation,
          message: `Could not ${operation} the encrypted attachment snapshot. Check the state directory and caller key.`,
        });
      yield* fs
        .makeDirectory(directory, { recursive: true, mode: 0o700 })
        .pipe(Effect.mapError(() => failure("write")));

      const load = Effect.fn("GatewayAttachments.load")(function* () {
        const stored = yield* fs.readFile(path).pipe(
          Effect.map(Option.some),
          Effect.catchIf(
            (error) => error.reason._tag === "NotFound",
            () => Effect.succeed(Option.none()),
          ),
          Effect.mapError(() => failure("read")),
        );
        if (Option.isNone(stored)) return [];
        const bytes = stored.value;
        const plaintext = yield* Effect.try({
          try: () => {
            const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12), {
              authTagLength: 16,
            });
            decipher.setAuthTag(bytes.subarray(12, 28));
            return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(
              "utf8",
            );
          },
          catch: () => failure("read"),
        });
        const snapshot = yield* decode(plaintext).pipe(Effect.mapError(() => failure("read")));
        return snapshot.entries;
      });

      const save = Effect.fn("GatewayAttachments.save")(function* (
        entries: ReadonlyArray<LiveAttachment>,
      ) {
        const nonce = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, nonce);
        const ciphertext = Buffer.concat([
          cipher.update(encode({ version: 1, entries }), "utf8"),
          cipher.final(),
        ]);
        const bytes = Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
        const temporary = `${path}.${crypto.randomUUID()}.tmp`;
        yield* fs.writeFile(temporary, bytes, { mode: 0o600, flag: "wx" }).pipe(
          Effect.andThen(fs.rename(temporary, path)),
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : fs.remove(temporary, { force: true }).pipe(
                  Effect.tapError(() =>
                    Effect.logError("Could not remove a temporary encrypted attachment snapshot", {
                      path: temporary,
                    }),
                  ),
                  Effect.ignore,
                ),
          ),
          Effect.mapError(() => failure("write")),
        );
        yield* Effect.logDebug("Persisted gateway attachments", { attachments: entries.length });
      });
      const persistence: AttachmentPersistence = {
        load: load().pipe(
          Effect.tapError((error) =>
            Effect.logError("Could not load gateway attachments", {
              path,
              operation: error.operation,
            }),
          ),
        ),
        save: (entries) =>
          save(entries).pipe(
            Effect.tapError((error) =>
              Effect.logError("Could not persist gateway attachments", {
                path,
                operation: error.operation,
              }),
            ),
          ),
      };
      return Attachments.layerWithPersistence(persistence);
    }),
  ).pipe(Layer.provide(NodeFileSystem.layer));

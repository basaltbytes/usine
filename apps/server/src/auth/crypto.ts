import { createHash, randomBytes } from "node:crypto";
import { Redacted } from "effect";
import { TokenHash } from "./model.ts";

export const randomSecret = () => Redacted.make(randomBytes(32).toString("base64url"));
export const secretHash = (secret: string) =>
  TokenHash.make(createHash("sha256").update(secret).digest("hex"));

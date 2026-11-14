// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createHash } from "node:crypto";

/** Names an isolated directory without collapsing punctuation in the identity. */
export const directoryName = (identity: string): string =>
  createHash("sha256").update(identity).digest("hex");

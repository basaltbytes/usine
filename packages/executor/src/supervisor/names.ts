// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createHash } from "node:crypto";
import type { AgentSessionId } from "@usine/core/agent/session";
import { Schema } from "effect";

/** Names an isolated directory without collapsing punctuation in the identity. */
export const directoryName = (identity: string): string =>
  createHash("sha256").update(identity).digest("hex");

/** The name of one conversation's files on the orchestrator: the SHA-256 of its ID, in hex. */
export const ConversationKey = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/u, { message: "A conversation key is 64 hex digits" }),
).pipe(Schema.brand("ConversationKey"));
export type ConversationKey = typeof ConversationKey.Type;

export const conversationKey = (conversation: AgentSessionId): ConversationKey =>
  ConversationKey.make(directoryName(conversation));

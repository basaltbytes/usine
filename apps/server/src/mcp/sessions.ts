import { Data } from "effect";
import type { CredentialId } from "../auth/model.ts";

/** An open MCP session: the credential that opened it and the tool server that holds it. */
export interface McpSession {
  readonly credential: CredentialId;
  /** The key of the tool server, which lists the session's tools. */
  readonly tools: string;
  /** Epoch milliseconds of the session's last request. */
  readonly lastUsedAt: number;
}

/** A session that the server ends on its tool server, and why. */
export interface EndingSession {
  readonly id: string;
  readonly session: McpSession;
  readonly reason: "idle" | "tools-changed";
}

/** How a request relates to the session that its `Mcp-Session-Id` names. */
export type SessionAdmission = Data.TaggedEnum<{
  Admitted: {};
  /** The session never existed or has ended. */
  Unknown: {};
  OtherCredential: {};
  /** The caller's tool list changed since it opened the session. */
  ToolsChanged: { readonly session: McpSession };
}>;
export const SessionAdmission = Data.taggedEnum<SessionAdmission>();

/** The open MCP sessions, by session ID. A session ends after `idleMillis` without a request. */
export const sessionTable = (idleMillis: number) => {
  const sessions = new Map<string, McpSession>();
  // Sessions that no request can use any more, but that their tool server didn't end.
  const unended = new Map<string, EndingSession>();
  return {
    open: (id: string, session: McpSession) => {
      sessions.set(id, session);
    },
    close: (id: string) => {
      sessions.delete(id);
    },
    /** Admits a request from `credential` with the tool list `tools`, and records its use. */
    admit: (id: string, credential: CredentialId, tools: string, now: number) => {
      const session = sessions.get(id);
      if (session === undefined) return SessionAdmission.Unknown();
      if (session.credential !== credential) return SessionAdmission.OtherCredential();
      if (session.tools !== tools) {
        sessions.delete(id);
        return SessionAdmission.ToolsChanged({ session });
      }
      sessions.set(id, { ...session, lastUsedAt: now });
      return SessionAdmission.Admitted();
    },
    /**
     * Removes and returns the sessions that went unused for the idle time, and the sessions passed
     * to `retry` since the last call.
     */
    takeStale: (now: number): ReadonlyArray<EndingSession> => {
      const stale = [...unended.values()];
      unended.clear();
      for (const [id, session] of sessions)
        if (now - session.lastUsedAt >= idleMillis) {
          sessions.delete(id);
          stale.push({ id, session, reason: "idle" });
        }
      return stale;
    },
    /** Keeps a session that its tool server didn't end, so the next `takeStale` returns it. */
    retry: (ending: EndingSession) => {
      unended.set(ending.id, ending);
    },
  };
};

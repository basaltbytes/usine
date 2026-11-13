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
  /** The caller's tool list changed since it opened the session; the next `takeStale` returns it. */
  ToolsChanged: {};
}>;
export const SessionAdmission = Data.taggedEnum<SessionAdmission>();

/** What a tool server's answer to the `DELETE` of a session means. */
export type SessionEnd = Data.TaggedEnum<{
  /** The tool server ended the session. */
  Ended: {};
  /** The tool server no longer had the session. */
  Gone: {};
  /**
   * The tool server refused. An ending session comes back from the next `takeStale`; a session
   * that its client asked to end stays open.
   */
  Refused: {};
}>;
export const SessionEnd = Data.taggedEnum<SessionEnd>();

/** Reads the HTTP status of a tool server's answer to a session's `DELETE`. */
const endOf = (status: number): SessionEnd =>
  status === 204 ? SessionEnd.Ended() : status === 404 ? SessionEnd.Gone() : SessionEnd.Refused();

/** The open MCP sessions, by session ID. A session ends after `idleMillis` without a request. */
export const sessionTable = (idleMillis: number) => {
  const sessions = new Map<string, McpSession>();
  // Sessions that no request can use any more, and that their tool server hasn't ended yet.
  const unended = new Map<string, EndingSession>();
  const retry = (ending: EndingSession) => {
    unended.set(ending.id, ending);
  };
  return {
    open: (id: string, session: McpSession) => {
      sessions.set(id, session);
    },
    /**
     * Settles the `DELETE` that a session's client sent, from its tool server's HTTP status. The
     * table forgets the session unless the tool server refused.
     */
    close: (id: string, status: number): SessionEnd => {
      const end = endOf(status);
      if (end._tag !== "Refused") sessions.delete(id);
      return end;
    },
    /** Admits a request from `credential` with the tool list `tools`, and records its use. */
    admit: (id: string, credential: CredentialId, tools: string, now: number) => {
      const session = sessions.get(id);
      if (session === undefined) return SessionAdmission.Unknown();
      if (session.credential !== credential) return SessionAdmission.OtherCredential();
      if (session.tools !== tools) {
        sessions.delete(id);
        retry({ id, session, reason: "tools-changed" });
        return SessionAdmission.ToolsChanged();
      }
      sessions.set(id, { ...session, lastUsedAt: now });
      return SessionAdmission.Admitted();
    },
    /**
     * Removes and returns the sessions that went unused for the idle time, the sessions whose tool
     * list changed, and the sessions passed to `retry` since the last call.
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
    /**
     * Settles an ending session from the HTTP status of its tool server's answer to `DELETE`. A
     * status other than 204 or 404 keeps the session for the next `takeStale`.
     */
    settle: (ending: EndingSession, status: number): SessionEnd => {
      const end = endOf(status);
      if (end._tag === "Refused") retry(ending);
      return end;
    },
    /** Keeps a session that its tool server didn't end, so the next `takeStale` returns it. */
    retry,
  };
};

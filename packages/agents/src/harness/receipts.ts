import type { OperatorMessageId } from "@usine/core/agent/session";
import { Data, Option } from "effect";

/**
 * Where the session read the messages that a receipt acknowledges: `now` at the receipt, a
 * tool-call count that the harness captured at the read, or `turn` when the receipt ends a turn.
 * At `turn`, a message that started the turn was read at its start, and any other message where
 * the turn folded it in: at the first tool result after the message was queued, or at the turn's
 * end if no tool call finished since. `restored` acknowledges a past read without attributing the
 * current turn's answer to it.
 */
export type ReadPoint = "now" | "turn" | "restored" | number;

/** A native record of one input, such as a Codex user-message item, and the turn that holds it. */
interface NativeItem {
  readonly id: string;
  readonly turn: string;
}

/**
 * What one harness signal says about the operator messages that its session read. Each adapter
 * decodes its harness's signals into receipts; `match` alone decides which messages they name.
 */
export type Receipt = Data.TaggedEnum<{
  /**
   * The harness names the messages that it read. `opensTurn` marks the first frame of a turn,
   * which names every message that started the turn.
   */
  ById: {
    readonly ids: ReadonlyArray<OperatorMessageId>;
    readonly at: ReadPoint;
    readonly opensTurn: boolean;
  };
  /**
   * The harness recorded an input with `text`. The record acknowledges the oldest of the session's
   * own inputs with that text, or else the oldest operator message with that text that this
   * process sent. At `restored`, it acknowledges the oldest unread message with that text, because
   * a record from before this process holds none of its own inputs. `item` names the native record,
   * which acknowledges once.
   */
  ByText: {
    readonly text: string;
    readonly at: ReadPoint;
    readonly item: Option.Option<NativeItem>;
  };
  /** At the end of a turn, the harness read every message that it was sent except the last `unread`. */
  ByCount: { readonly unread: number };
  /** The last `turns` messages that the harness hasn't read each start a turn after this receipt. */
  TurnsQueued: { readonly turns: number };
  /**
   * The native records of `turn`, from before the session saved the records it counted. They
   * acknowledge nothing, because each may record an earlier message with the same text.
   */
  Seen: { readonly turn: string; readonly items: ReadonlyArray<string> };
}>;
export const Receipt = Data.taggedEnum<Receipt>();

/** An operator message that the session hasn't read. */
export interface Unread {
  readonly id: OperatorMessageId;
  readonly message: string;
  /** Whether this process sent the message to the native session. */
  readonly sent: boolean;
  /** The session's count of finished tool calls when the message was queued. */
  readonly queuedAfter: number;
  /** The tool-call count where the message starts a turn of its own, if it does. */
  readonly turnStart: Option.Option<number>;
}

/** The operator messages that the session hasn't read, and the native records it counted. */
export interface Inbox<A extends Unread> {
  /** Oldest first. */
  readonly unread: ReadonlyArray<A>;
  /**
   * The texts of the inputs that this process sent on the session's own behalf, such as its task or
   * a continuation message, that the harness hasn't recorded, oldest first.
   */
  readonly own: ReadonlyArray<string>;
  /** The native items that the session already counted, which acknowledge nothing again. */
  readonly counted: ReadonlyArray<string>;
  /** The turn whose items `saved` lists. */
  readonly turn: Option.Option<string>;
  /** The items of `turn` that `ChildSessionJournal.received` saved. */
  readonly saved: ReadonlyArray<string>;
}

/** What a receipt changed. */
export interface Matched<A extends Unread> {
  readonly inbox: Inbox<A>;
  /** The messages that the receipt acknowledges, oldest first, with where the session read each. */
  readonly read: ReadonlyArray<{ readonly message: A; readonly at: ReadPoint }>;
  /** The items of the inbox's turn to save before the reads are reported, if the receipt counted new ones. */
  readonly save: Option.Option<ReadonlyArray<string>>;
  /** The native item that the receipt repeats. */
  readonly repeated: Option.Option<NativeItem>;
  /** Whether the receipt recorded one of the session's own inputs instead of an operator message. */
  readonly own: boolean;
  /** The messages that now start a turn of their own. */
  readonly turnsQueued: number;
  /** The messages that no longer start a turn of their own, because another message opened it. */
  readonly folded: number;
}

/** Where a message that a turn-ending receipt acknowledges was read. */
const atTurnEnd = (message: Unread): ReadPoint =>
  Option.getOrElse(message.turnStart, (): ReadPoint => "turn");

/** Counts `item` in the inbox, which saves it with the other items of its turn. */
const count = <A extends Unread>(inbox: Inbox<A>, { id, turn }: NativeItem): Inbox<A> => ({
  ...inbox,
  counted: [...inbox.counted, id],
  turn: Option.some(turn),
  saved: Option.contains(inbox.turn, turn)
    ? inbox.saved.includes(id)
      ? inbox.saved
      : [...inbox.saved, id]
    : [id],
});

/** Reports `read` and removes it from the inbox. */
const acknowledged = <A extends Unread>(
  inbox: Inbox<A>,
  read: ReadonlyArray<{ readonly message: A; readonly at: ReadPoint }>,
  changes: Partial<Omit<Matched<A>, "inbox" | "read">> = {},
): Matched<A> => ({
  inbox: {
    ...inbox,
    unread: inbox.unread.filter((message) => !read.some((entry) => entry.message === message)),
  },
  read,
  save: Option.none(),
  repeated: Option.none(),
  own: false,
  turnsQueued: 0,
  folded: 0,
  ...changes,
});

/**
 * Applies `receipt` to `inbox`: the messages that it acknowledges leave the inbox, oldest first.
 * `calls` is the session's current count of started tool calls.
 */
export const match = <A extends Unread>(
  inbox: Inbox<A>,
  receipt: Receipt,
  calls: number,
): Matched<A> =>
  Receipt.$match(receipt, {
    ById: ({ ids, at, opensTurn }) => {
      const read = inbox.unread
        .filter(({ id }) => ids.includes(id))
        .map((message) => ({ message, at: at === "turn" ? atTurnEnd(message) : at }));
      if (!opensTurn) return acknowledged(inbox, read);
      const later = inbox.unread.filter(
        ({ id, turnStart }) => Option.isSome(turnStart) && !ids.includes(id),
      );
      return acknowledged(
        {
          ...inbox,
          unread: inbox.unread.map((message) =>
            later.includes(message) ? { ...message, turnStart: Option.none() } : message,
          ),
        },
        read,
        { folded: later.length },
      );
    },
    ByText: ({ text, at, item }) => {
      if (Option.isSome(item) && inbox.counted.includes(item.value.id))
        return acknowledged(inbox, [], { repeated: item });
      const counted = Option.match(item, {
        onNone: () => inbox,
        onSome: (found) => count(inbox, found),
      });
      const save = Option.map(item, () => counted.saved);
      const own = at === "restored" ? -1 : counted.own.indexOf(text);
      if (own >= 0)
        return acknowledged(
          { ...counted, own: counted.own.filter((_, index) => index !== own) },
          [],
          { save, own: true },
        );
      const message = counted.unread.find(
        (candidate) => (at === "restored" || candidate.sent) && candidate.message === text,
      );
      return acknowledged(counted, message === undefined ? [] : [{ message, at }], { save });
    },
    ByCount: ({ unread }) => {
      const sent = inbox.unread.filter((message) => message.sent);
      return acknowledged(
        inbox,
        sent
          .slice(0, Math.max(0, sent.length - unread))
          .map((message) => ({ message, at: atTurnEnd(message) })),
      );
    },
    TurnsQueued: ({ turns }) => {
      const queued = turns > 0 ? inbox.unread.filter((message) => message.sent).slice(-turns) : [];
      return acknowledged(
        {
          ...inbox,
          unread: inbox.unread.map((message) =>
            queued.includes(message) ? { ...message, turnStart: Option.some(calls) } : message,
          ),
        },
        [],
        { turnsQueued: queued.length },
      );
    },
    Seen: ({ turn, items }) =>
      acknowledged(
        {
          ...inbox,
          counted: [...inbox.counted, ...items.filter((id) => !inbox.counted.includes(id))],
          turn: Option.some(turn),
          saved: items,
        },
        [],
        { save: Option.some(items) },
      ),
  });

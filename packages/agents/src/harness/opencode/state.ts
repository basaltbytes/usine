import { BackgroundWork } from "@usine/core/agent/session";
import { Data, Option } from "effect";

/** Why the runtime interrupts an execution: the conversation's pause, or the session's stop. */
export type InterruptIntent = "pause" | "stop";

/**
 * The root session's execution, by the events that the runtime handled. Each terminal event of
 * the execution leaves it `Idle`, except an interrupted pause that a late input keeps open, and a
 * success while OpenCode holds input that it hasn't delivered.
 */
export type Execution = Data.TaggedEnum<{
  Idle: {};
  Running: {};
  /**
   * The execution succeeded while input was undelivered. The execution that the input starts
   * answers instead, unless every such input fails.
   */
  AwaitingInput: {};
  /**
   * The runtime posted an interrupt for `intent`, which OpenCode `answered` or not yet. `late` holds
   * the keys of the inputs posted after the answer of a pause, each of which can start a successor
   * execution.
   */
  Interrupting: {
    readonly intent: InterruptIntent;
    readonly answered: boolean;
    readonly late: ReadonlyArray<number>;
  };
  /**
   * The paused execution ended with `reason` while the late inputs `late` were undelivered. The
   * successor execution that they start ends the turn.
   */
  AwaitingSuccessor: { readonly reason: string; readonly late: ReadonlyArray<number> };
}>;
export const Execution = Data.taggedEnum<Execution>();

/**
 * Returns whether to post an interrupt for `intent`, and the execution after the request. Only a
 * running execution gets an interrupt; a stop during a pause's interrupt makes it a stop.
 */
export const requestInterrupt = (
  execution: Execution,
  intent: InterruptIntent,
): readonly [boolean, Execution] => {
  switch (execution._tag) {
    case "Running":
      return [true, Execution.Interrupting({ intent, answered: false, late: [] })];
    case "Interrupting":
      return [
        false,
        intent === "stop" ? Execution.Interrupting({ ...execution, intent }) : execution,
      ];
    case "Idle":
    case "AwaitingInput":
    case "AwaitingSuccessor":
      return [false, execution];
  }
};

/** Returns the execution after OpenCode answered its interrupt. */
export const interruptAnswered = (execution: Execution): Execution =>
  execution._tag === "Interrupting"
    ? Execution.Interrupting({ ...execution, answered: true })
    : execution;

/** Returns the execution after OpenCode refused its interrupt, which keeps it running. */
export const interruptRefused = (execution: Execution): Execution =>
  execution._tag === "Interrupting" ? Execution.Running() : execution;

/**
 * Returns whether input `key`, posted now, is late, and the execution that records it: an input
 * posted after the answer of a pause's interrupt can start a successor execution.
 */
export const inputPosted = (execution: Execution, key: number): readonly [boolean, Execution] =>
  execution._tag === "Interrupting" && execution.intent === "pause" && execution.answered
    ? [true, Execution.Interrupting({ ...execution, late: [...execution.late, key] })]
    : [false, execution];

/** How `session.execution.interrupted` ends: it ends the turn, or a late input defers it. */
export type InterruptedOutcome = Data.TaggedEnum<{
  /** The turn ends; `intent` is the runtime's interrupt, if any. */
  Ends: { readonly intent: Option.Option<InterruptIntent> };
  /** The late inputs `late` are undelivered, so their successor execution ends the turn. */
  Deferred: { readonly late: ReadonlyArray<number> };
}>;
export const InterruptedOutcome = Data.taggedEnum<InterruptedOutcome>();

/**
 * Returns how `session.execution.interrupted` with `reason` ends `execution`, and the execution
 * after it, given the inputs that are still `pending`.
 */
export const executionInterrupted = (
  execution: Execution,
  reason: string,
  pending: Pending,
): readonly [InterruptedOutcome, Execution] => {
  if (execution._tag !== "Interrupting")
    return [InterruptedOutcome.Ends({ intent: Option.none() }), Execution.Idle()];
  const late = execution.late.filter((key) => isPending(pending, key));
  if (execution.intent === "pause" && late.length > 0)
    return [InterruptedOutcome.Deferred({ late }), Execution.AwaitingSuccessor({ reason, late })];
  return [InterruptedOutcome.Ends({ intent: Option.some(execution.intent) }), Execution.Idle()];
};

/**
 * Returns the reason of the paused execution that ends the turn once input `key` failed, if no
 * late input still keeps it open, and the execution after the failure.
 */
export const lateInputFailed = (
  execution: Execution,
  key: number,
): readonly [Option.Option<string>, Execution] => {
  if (execution._tag !== "AwaitingSuccessor") return [Option.none(), execution];
  const late = execution.late.filter((other) => other !== key);
  return late.length > 0
    ? [Option.none(), Execution.AwaitingSuccessor({ ...execution, late })]
    : [Option.some(execution.reason), Execution.Idle()];
};

/**
 * Returns whether the answer of the execution that succeeded is due, because no input that it
 * waited for remains, and the execution after the check.
 */
export const answerDue = (execution: Execution, pending: Pending): readonly [boolean, Execution] =>
  execution._tag === "AwaitingInput" && unread(pending) === 0
    ? [true, Execution.Idle()]
    : [false, execution];

/** An input that the session posted, until OpenCode delivers it or the post fails. */
interface PostedInput {
  readonly key: number;
  /** OpenCode's inbox ID of the input, known once posted with one or once answered. */
  readonly id: Option.Option<string>;
}

/** A session that the root session started, such as a subagent, or that one of those started. */
interface ChildSession {
  readonly title: string;
  /** Whether an execution of the child runs, by the events that the runtime handled. */
  readonly running: boolean;
}

/**
 * The input and background work of a session tree, by what the runtime posted and the events that
 * it handled. Each starts another execution of the root session when OpenCode delivers it or when
 * it ends.
 */
export interface Pending {
  readonly inputs: ReadonlyArray<PostedInput>;
  readonly nextKey: number;
  /** The inbox IDs that OpenCode delivered while an input waited for its ID. */
  readonly deliveredEarly: ReadonlySet<string>;
  /** The inbox IDs that OpenCode queued on the root session and hasn't delivered or cancelled. */
  readonly queued: ReadonlySet<string>;
  /** The commands of the tree's running shells, by shell ID. */
  readonly shells: ReadonlyMap<string, string>;
  /** The tree's child sessions, by OpenCode session ID. */
  readonly children: ReadonlyMap<string, ChildSession>;
}

export const emptyPending: Pending = {
  inputs: [],
  nextKey: 0,
  deliveredEarly: new Set(),
  queued: new Set(),
  shells: new Map(),
  children: new Map(),
};

const isPending = (pending: Pending, key: number) =>
  pending.inputs.some((input) => input.key === key);

/** Keeps the early deliveries only while an input waits for its ID. */
const settled = (pending: Pending): Pending =>
  pending.inputs.some((input) => Option.isNone(input.id))
    ? pending
    : { ...pending, deliveredEarly: new Set() };

/** Returns the key of an input posted with `id`, if known, and the state that tracks it. */
export const trackInput = (
  pending: Pending,
  id: Option.Option<string>,
): readonly [number, Pending] => [
  pending.nextKey,
  {
    ...pending,
    nextKey: pending.nextKey + 1,
    inputs: [...pending.inputs, { key: pending.nextKey, id }],
  },
];

/** Records that OpenCode answered the post of input `key` with inbox ID `id`. */
export const answered = (pending: Pending, key: number, id: string): Pending => {
  if (!pending.deliveredEarly.has(id))
    return settled({
      ...pending,
      inputs: pending.inputs.map((input) =>
        input.key === key ? { ...input, id: Option.some(id) } : input,
      ),
    });
  const deliveredEarly = new Set(pending.deliveredEarly);
  deliveredEarly.delete(id);
  return settled({
    ...pending,
    deliveredEarly,
    inputs: pending.inputs.filter((input) => input.key !== key),
  });
};

/** Drops input `key`, whose post failed. */
export const failed = (pending: Pending, key: number): Pending =>
  settled({ ...pending, inputs: pending.inputs.filter((input) => input.key !== key) });

/** Records that OpenCode queued inbox item `id` on the root session. */
export const enqueued = (pending: Pending, id: string): Pending => ({
  ...pending,
  queued: new Set(pending.queued).add(id),
});

/** Records that OpenCode delivered or cancelled inbox item `id` of the root session. */
export const removed = (pending: Pending, id: string): Pending => {
  const queued = new Set(pending.queued);
  queued.delete(id);
  const inputs = pending.inputs.filter((input) => !Option.contains(input.id, id));
  const early =
    inputs.length === pending.inputs.length && inputs.some((input) => Option.isNone(input.id));
  return settled({
    ...pending,
    queued,
    inputs,
    deliveredEarly: early ? new Set(pending.deliveredEarly).add(id) : pending.deliveredEarly,
  });
};

/** Returns how many inputs and queued items OpenCode hasn't delivered. */
export const unread = (pending: Pending): number =>
  pending.inputs.length +
  [...pending.queued].filter((id) => !pending.inputs.some((input) => Option.contains(input.id, id)))
    .length;

/** Returns whether `session` is root session `root` or one of its child sessions. */
export const inTree = (pending: Pending, root: string, session: string): boolean =>
  session === root || pending.children.has(session);

/** Records child session `child` of `parent` with `title`, if `parent` is in the tree of `root`. */
export const childCreated = (
  pending: Pending,
  root: string,
  child: { readonly id: string; readonly parent: string; readonly title: string },
): Option.Option<Pending> =>
  inTree(pending, root, child.parent)
    ? Option.some({
        ...pending,
        children: new Map(pending.children).set(child.id, { title: child.title, running: false }),
      })
    : Option.none();

/** Records whether an execution of child session `child` runs. */
export const childRunning = (pending: Pending, child: string, running: boolean): Pending => {
  const found = pending.children.get(child);
  return found === undefined
    ? pending
    : { ...pending, children: new Map(pending.children).set(child, { ...found, running }) };
};

/** Records shell `id` running `command`, if `session` started it in the tree of `root`. */
export const shellStarted = (
  pending: Pending,
  root: string,
  shell: { readonly id: string; readonly command: string; readonly session: string },
): Pending =>
  inTree(pending, root, shell.session)
    ? { ...pending, shells: new Map(pending.shells).set(shell.id, shell.command) }
    : pending;

/** Records that shell `id` exited or was deleted. */
export const shellEnded = (pending: Pending, id: string): Pending => {
  if (!pending.shells.has(id)) return pending;
  const shells = new Map(pending.shells);
  shells.delete(id);
  return { ...pending, shells };
};

/** Returns the tree's running shells and child executions as background work. */
export const runningWork = (pending: Pending): ReadonlyArray<BackgroundWork> => [
  ...[...pending.shells].map(([id, command]) =>
    BackgroundWork.make({ id, kind: "command", description: command }),
  ),
  ...[...pending.children]
    .filter(([, child]) => child.running)
    .map(([id, child]) => BackgroundWork.make({ id, kind: "agent", description: child.title })),
];

/**
 * Returns the state after a new OpenCode process reopened the session: the earlier process's
 * background work stopped with it, and the conversation sends its unread input again.
 */
export const restarted = (pending: Pending): Pending => ({
  ...emptyPending,
  nextKey: pending.nextKey,
  children: new Map([...pending.children].map(([id, child]) => [id, { ...child, running: false }])),
});

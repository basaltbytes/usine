# pi-durable 1.1.0 as the Pi parent runtime

Research date: 2026-10-08. Sources: the [announcement](https://earendil.com/posts/pi-durable), the published `@earendil-works/pi-durable@1.1.0` package (README, CHANGELOG, type declarations), `packages/durable/docs/spec.md` and the examples in the [pi repo](https://github.com/earendil-works/pi), the experimental durable coding agent at `packages/coding-agent/src/experimental/durable`, and a crash-and-resume experiment run against the package (appendix).

## Finding

pi-durable is a single-process agent harness over one storage: conversations, model turns, tool calls, and host documents are committed atomically before anything is shown, and a reopened storage continues unfinished work from its last checkpoint. It ships SQLite (Node and Cloudflare Durable Object), JSONL, and memory backends, a conformance suite for custom ones, a durable task state machine with ownership and bottom-up abort, an inbox (steer, follow-up, write) for busy conversations, per-conversation agent configuration stored as names, and two observation surfaces (`watch()` for structural view operations, `watchEvents()` for coding-agent style events) that late joiners attach to without replay.

It replaces usine's **attempt channel, run host, transcript store, Pi parent session plumbing, and the Effect workflow that holds the Run lifecycle**, and adds what usine does not have today: resume of a live Attempt after an orchestrator crash, late-join and multi-client observation of a running session, and operator interventions as ordinary submissions. It does **not** replace the child harness backends (Claude Agent SDK, Codex app-server, Pi child), the executor's worktree, credential, and salvage work, triggers and the Event ledger, the Item and Event rows, or the web UI. Those are the larger part of the code.

Adopting it means one architectural change: the Pi parent moves from the Worker into the orchestrator process, and Workers become the place children run. The Run lifecycle itself becomes a pi-durable task on the same storage, so one durable substrate holds Runs, Attempts, and conversations. That replaces ADR 0003's Effect workflow and ADR 0006's one-shot run host; the ADRs get a dated amendment with the new why.

## Package facts

| Fact | Value |
|---|---|
| Version | 1.1.0 (2026-10-07); 1.0.0 was 2026-10-01; 1.1.0 and 1.0.3 both carry breaking changes |
| Status | "Experimental. The API changes without notice between releases." |
| Dependencies | `@earendil-works/pi-ai ^1.1.0`, `@earendil-works/chord ^1.1.0`, `typebox 1.3.27`, `diff 8.0.4` |
| Node | `>=22.19.0`; SQLite via `node:sqlite` |
| Process model | "One process owns a storage at a time; there is no cross-process locking." |
| Spec non-goals | no multi-writer merge, no forced termination of non-cooperative extension code inside one process |
| Failure mode | a commit that fails after storage admission poisons the whole Session: "reopen it" |

usine pins `@earendil-works/pi-coding-agent 0.85.1`, which depends on `pi-ai ^0.85.1`. pi-durable needs `pi-ai ^1.1.0`. The coding-agent package reached 1.1.0 on the same day with a 6,200-line changelog since 0.85. Sharing one `pi-ai` means upgrading the coding-agent SDK first. `ModelRuntime.create`, which usine's `sdk.ts` already uses for API-key and ChatGPT OAuth resolution, is still exported in 1.1.0, and pi-ai 1.1 still ships the `anthropic` and `openai-codex` providers.

## Mapping to usine concepts

| usine today | pi-durable equivalent | Notes |
|---|---|---|
| Pi parent `AgentSession` in the run host, driven through `session.ts`, `conversation.ts`, `turns.ts` | a task-owned `Conversation` with `instructions`, `model`, and the subagent tool selected | `configure()` stores names; the registry supplies code |
| Attempt channel protocol v7 (NDJSON over stdio or SSH) | none: tool calls commit their intent and output every 100 ms into storage | the "channel" is the commit line |
| Transcript rows appended as envelopes arrive | conversation entries plus `pi.live` document | `watchEvents()` yields `message_start`, `tool_execution_update`, `inbox_update`, ... |
| Run drawer live tail and history | `watch()` or `watchEvents()` snapshot plus deltas; a slow client gets a fresh snapshot after 100 frames | late join starts from the current view, nothing replayed |
| Steer | `submit({ whenBusy: "steer" })`, placed after the current tool round | verified in the experiment |
| Interrupt (pause until guidance) | `abort()` the conversation then `submit()` guidance, or a `beforeTool` hook that blocks | not a one-call primitive |
| Operator message to a child, Hold, Release | `submit()` to the child conversation; the subagent tool checks a hold document before returning | the `23-subagent-background` example shows the reporter and request-id pattern |
| Child session events under the parent | the subagent call's `details` carries the child conversation id; clients attach to it | the experimental durable TUI does this |
| Cancel and supersede | `harness.abortTask()` on the Run task aborts owned work bottom-up: child tool call, then conversation, then the task's abort handler | documented and covered upstream; not exercised in the experiment |
| Approval as a consumed Event | a task phase that watches an approval document; the operator commits the document from outside | verified in the experiment |
| Retry as a new Attempt | a new checkpoint in the Run task, with a new `requestId` for the parent submission | `requestId` makes the submission exactly-once across restarts |
| Crash mid-Attempt: new Attempt from scratch | the tool call that spawned the child gets an `interrupted` result with its committed output; the parent model continues and can resume the child by the native session id usine already records | this is the headline gain |
| Pool usage from `SessionTokensUpdated` events | `pi.usage` per conversation and `harness.usage()`; tool results may report usage | children's own meters still come from the child backends |
| Compaction: none for the parent | background and manual compaction with retry on context overflow | free |

## Topology

```
today                                      with pi-durable

orchestrator (Effect, SQLite)              orchestrator (Effect, SQLite + pi-durable storage)
  Event ledger, Run/Step/Attempt             Event ledger, Run/Step/Attempt
  transcript rows  <-- protocol v7 --+       harness: parent conversations, tasks, documents
  intervention router  -- v7 -->     |         subagent tool ---- child spawn transport ----+
                                     |       watch()/watchEvents() -> web UI                |
worker                               |                                                      |
  run host (one-shot process)  ------+     worker                                           |
    Pi parent session                        child process: claude / codex app-server  <----+
    subagents extension                      (stdio locally, ssh exec on exe.dev)
      claude / codex / pi child              worktree, credentials, salvage: unchanged
```

The parent's own tool set is the subagent tool and nothing else, so the parent needs no `ExecutionEnv`; the Worker seam shrinks to "spawn a harness child here and give me its stdio". Locally that is a child process. On exe.dev it is the SSH exec the executor already runs for the run host. The Claude child is launched by the Agent SDK with `pathToClaudeCodeExecutable: "claude"`; pointing that at an SSH wrapper is the thing to verify first. The Codex child already speaks JSON-RPC over a spawned process's stdio and only needs the spawn to go through the transport. Pi children would run in the orchestrator under the same harness as plain owned conversations.

Credentials move in the right direction: the Pi parent's API key or ChatGPT OAuth lives with the orchestrator, children keep using the Worker's login state, and no secret travels on a channel.

## What the experiment showed

Script in the appendix. A `usine.run` task with phases `gate -> attempt -> settle`, an approval document the operator commits from outside, a task-owned parent conversation, and a `harness_child` tool that is not replay-safe and calls `process.exit(3)` after committing two lines of output.

- The task parked in `gate` until the approval document changed, then created the parent conversation and submitted the attempt with `requestId: attempt:<task>:1`.
- The process died inside the tool call. The saved task state was `pending` at checkpoint `{ phase: "attempt", attempt: 1 }`.
- A fresh process over the same SQLite file attached `watchEvents()` to the parent before resuming and received the snapshot `[pi.user, pi.system, pi.assistant]`.
- `resume()` re-entered the `attempt` phase, found the same conversation through task ownership and the same submission (id 16) through its `requestId`, and the tool call settled as `interrupted` with the two output lines preserved in the tool result.
- An operator steer submitted while the attempt was live was placed after the tool round and appeared as the next user turn before the final answer.
- The task completed; `harness.usage()` reported the two model calls.

Two mistakes in the first draft of the script are worth recording because usine code will make them too. A `runtime.commit` callback's return value is the task's next state, so returning a conversation id from it corrupted the task row, and the resulting failed commit poisoned the Session for every later call until reopen. `watchDoc()` on a document that no commit has created yet returns `undefined`, so a document must be created in an intent commit before it is watched.

## Risks

- **API churn.** Two breaking releases in the package's first week. Exact pin, as with every Pi package, and budget for migrations.
- **One Session, one process.** A single bad commit from any extension poisons the Session for every running conversation. The orchestrator needs a reopen supervisor, and extensions need the same typed-boundary discipline as everything else.
- **No forced termination in-process.** A tool that does not honour its abort signal cannot be killed without killing the orchestrator. Mitigated because the parent's only tool delegates to a remote process the transport can kill.
- **Two SQLite connections, one file.** usine's own rows (Items, Events, Workers, projections) stay under drizzle; Runs, Attempts, and conversations live in pi-durable storage. A usine row and a pi-durable commit are never one transaction, so ADR 0010's projection-plus-startup-sweep pattern stays for the rows usine keeps.
- **Web UI rework.** The run drawer, ADR 0025's bookmarks, and the transcript reader are keyed on transcript sequences and Attempt/session/call ids. They would read conversation entries and `watchEvents()` instead.
- **Remote child spawn.** The Agent SDK over an SSH wrapper is unverified. If it does not work, the exe.dev adapter would drive the Claude CLI's stream-json mode directly over SSH.
- **Cloudflare.** The Durable Object adapter exists and is the natural home for a one-writer harness, but spawning children on a Worker from a Durable Object needs a worker-side agent protocol that does not exist yet. Not a blocker for the local and exe.dev targets.

## Recommendation

Adopt as the single durable substrate. usine has no users, so a staged migration beside the Effect workflow would be cost without anyone to protect. Order of work:

1. **Upgrade the Pi packages to 1.1.0** on their own: `pi-coding-agent`, `pi-ai`, `chord`. Required to share `pi-ai`, and it isolates the SDK migration from the architecture change.
2. **Run as a pi-durable task** (gate, attempt, settle, as in the appendix) with the parent conversation owned by the task, the subagent tool spawning the existing Claude and Codex backends through a local child-spawn transport, and the run drawer reading `watchEvents()`. Interventions become submissions: steer is `whenBusy: "steer"`, operator messages to a child are submits to the child conversation, Hold is a document the subagent tool checks before returning. Check: an orchestrator restart during an Attempt resumes it instead of opening a new Attempt.
3. **exe.dev transport**, after verifying the Agent SDK over an SSH wrapper.
4. **Delete** the run host package, protocol v7, the transcript store, the parent-side session plumbing in `@usine/agents`, the Effect workflow, and the cluster tables.

ADRs to amend with the new why: 0003 (Run durability is a pi-durable task), 0006 (run host and attempt channel become the child-spawn transport; reattach is in), 0018 (interventions as submissions), 0010 (two SQLite connections, one file), 0005 (the subagents extension becomes a pi-durable extension).

## Appendix: experiment script

Run with pi-durable, pi-ai, and chord at 1.1.0 installed beside it:

```sh
node --experimental-strip-types run-shaped.ts 1   # crashes on purpose inside the tool call
node --experimental-strip-types run-shaped.ts 2   # reopens the same SQLite file and finishes the run
```

```ts
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	configure,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	Harness,
	type ConversationId,
	type TaskId,
	watchEvents,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const context = BACKGROUND_CONTEXT;
const phase = process.argv[2] ?? "1";
const DB = "./run-shaped.sqlite";
const STATE = "./run-shaped.json";
const log = (...a: unknown[]) => console.log(`[p${phase}]`, ...a);

if (phase === "1") for (const f of [DB, `${DB}-wal`, `${DB}-shm`, STATE]) if (existsSync(f)) rmSync(f);

// operator approval as a durable document scoped to the Run task
const Approval = defineDoc<{ approved: boolean }>({
	kind: "usine.approval",
	version: 1,
	scope: "task",
	initial: () => ({ approved: false }),
});

// the harness child tool: long-running and not replay safe, like a real Claude Code child
const harnessChild = defineTool({
	name: "harness_child",
	description: "Run a coding harness child",
	parameters: Type.Object({ task: Type.String() }),
	execute: async (args, api, ctx) => {
		api.output(`child started: ${args.task}\n`);
		await new Promise((r) => setTimeout(r, 150));
		api.output("child wrote file a.ts\n");
		await new Promise((r) => setTimeout(r, 150));
		if (phase === "1") {
			log("crashing the process inside the tool call");
			process.exit(3);
		}
		api.output("child finished\n");
		return { content: [{ type: "text", text: "child result: PR #42 opened" }] };
	},
});

type RunState =
	| { phase: "gate" }
	| { phase: "attempt"; attempt: number }
	| { phase: "settle"; attempt: number; answer: string };
const Run = defineTask<{ task: string; approval: boolean }, RunState, { answer: string; attempts: number }>({
	name: "usine.run",
	version: 1,
	initial: () => ({ phase: "gate" }),
	phases: {
		gate: async (task, runtime, ctx) => {
			if (task.input.approval) {
				// intent: the approval document exists before anyone watches it
				await runtime.commit(async (tx) => {
					await tx.doc(Approval, task.id);
					return undefined;
				}, ctx);
				const watch = (await runtime.watchDoc(Approval, task.id, ctx))!;
				if (!watch.value?.approved) {
					log("run parked for approval");
					await new Promise<void>((resolve) => {
						watch.start(async (value) => {
							if (value?.approved) resolve();
						});
					});
					await watch.stop();
				}
				log("approval observed");
			}
			await runtime.commit(() => ({ status: "running", checkpoint: { phase: "attempt", attempt: 1 } }), ctx);
		},
		attempt: async (task, runtime, ctx) => {
			const attempt = task.state.checkpoint.attempt;
			// intent: the parent conversation, found again after a crash through task ownership
			let parentId!: ConversationId;
			await runtime.commit(async (tx) => {
				const existing = (await tx.scanConversations({ ownerTaskId: task.id }, 1)).items[0];
				if (existing !== undefined) {
					parentId = existing.id;
					return undefined;
				}
				const created = await tx.createConversation({ ownership: { kind: "task", taskId: task.id } });
				await configure(tx, created.id, {
					model: { provider: "faux", modelId: "faux-1" },
					instructions: "You are the usine Pi parent.",
				});
				parentId = created.id;
				return undefined;
			}, ctx);
			writeFileSync(STATE, JSON.stringify({ runId: task.id, parentId }));
			const parent = (await runtime.conversation(parentId, ctx))!;
			const submission = await parent.submit(
				{ type: "input", content: task.input.task, requestId: `attempt:${task.id}:${attempt}` },
				ctx,
			);
			log(`attempt ${attempt} submitted as ${submission.id} on parent ${parentId}`);
			const settled = await submission.wait(ctx);
			if (settled.status !== "done" || settled.type !== "input") {
				await runtime.commit(
					() => ({ status: "terminal", outcome: { status: "failed", error: { message: "unanswered" } } }),
					ctx,
				);
				return;
			}
			const entry = await runtime.entry(AssistantEntry, settled.answer, ctx);
			const message = entry?.model?.[0] as { content: Array<{ type: string; text?: string }> } | undefined;
			const answer = (message?.content ?? []).flatMap((c) => (c.type === "text" ? [c.text ?? ""] : [])).join("");
			await runtime.commit(() => ({ status: "running", checkpoint: { phase: "settle", attempt, answer } }), ctx);
		},
		settle: async (task, runtime, ctx) => {
			const { answer, attempt } = task.state.checkpoint;
			await runtime.commit(
				() => ({ status: "terminal", outcome: { status: "completed", result: { answer, attempts: attempt } } }),
				ctx,
			);
		},
	},
	abort: async (_task, runtime, ctx) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
	},
});

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses(
	phase === "1"
		? [fauxAssistantMessage([fauxToolCall("harness_child", { task: "fix #12" }, { id: "call-1" })], { stopReason: "toolUse" })]
		: [fauxAssistantMessage([fauxText("Attempt finished after the interrupted child; steer was seen.")])],
);
const registry = createRegistry();
registry.install(defineExtension({ name: "usine", tools: [harnessChild], tasks: [Run] }));
const harness = await Harness.open(await openNodeSqliteStorage(DB), { models, registry }, context);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });

if (phase === "1") {
	const runId = await root.commit(
		(tx) => tx.createTask(Run, { task: "Fix issue #12 and open a PR", approval: true }, { ownership: { kind: "conversation" } }),
		context,
	);
	log("run task created", runId);
	harness.resume();
	await new Promise((r) => setTimeout(r, 200));
	log("graph:", Object.values((await harness.taskGraph(context)).value.tasks).map((n) => `${n.kind}:${n.state.status}`));
	// the operator approves from outside the task: one document commit
	await harness.commit(async (tx) => {
		(await tx.doc(Approval, runId)).approved = true;
	}, context);
	log("operator approved");
	await new Promise((r) => setTimeout(r, 5_000));
	log("ERROR: the tool should have crashed the process by now");
	process.exit(1);
} else {
	const { runId, parentId } = JSON.parse(readFileSync(STATE, "utf8")) as {
		runId: TaskId<{ answer: string; attempts: number }>;
		parentId: ConversationId;
	};
	log("saved task state before resume:", JSON.stringify((await harness.getTask(runId, context))?.state));
	// late join: attach an event stream to the parent conversation before resuming
	const stream = await watchEvents(harness, parentId, context);
	log("snapshot entries:", stream.snapshot.entries.map((e) => e.kind));
	const seen: string[] = [];
	stream.start(async (events) => {
		for (const e of events) seen.push(e.type);
	});
	const parent = (await harness.conversation(parentId, context))!;
	harness.resume();
	// operator steer while the attempt is live
	await parent.submit({ type: "input", content: "Operator steer: use pnpm", whenBusy: "steer" }, context);
	const done = await harness.waitForTask(runId, context);
	log("run outcome:", JSON.stringify(done.state.outcome));
	await new Promise((r) => setTimeout(r, 100));
	const page = await parent.entries({}, 50, undefined, context);
	for (const e of [...page.items].reverse()) {
		log("entry", e.kind, e.kind === "pi.system" ? "" : JSON.stringify((e as { model?: unknown }).model).slice(0, 260));
	}
	log("events seen after late join:", [...new Set(seen)].join(", "));
	log("usage:", JSON.stringify(await harness.usage(context)));
	await stream.stop();
}
await harness.close(context);
```

Observed output of phase 2:

```text
[p2] saved task state before resume: {"status":"pending","checkpoint":{"phase":"attempt","attempt":1}}
[p2] snapshot entries: [ 'pi.user', 'pi.system', 'pi.assistant' ]
[p2] attempt 1 submitted as 16 on parent 9
[p2] run outcome: {"status":"completed","result":{"answer":"","attempts":1}}
[p2] entry pi.user [{"role":"user","content":"Fix issue #12 and open a PR", ...}]
[p2] entry pi.system
[p2] entry pi.assistant [{"role":"assistant","content":[{"type":"toolCall","id":"call-1","name":"harness_child", ...
[p2] entry pi.tool-result [{"role":"toolResult","toolCallId":"call-1","toolName":"harness_child","content":[{"type":"text","text":"child started: fix #12\nchild wrote file a.ts\n"},{"type":"text","text":"<harness>\n[error] Tool harness_child was interrupted and may have partially run\n ...
[p2] entry pi.user [{"role":"user","content":"Operator steer: use pnpm", ...}]
[p2] entry pi.assistant [{"role":"assistant","content":[{"type":"text","text":"Attempt finished after the interrupted child; steer was seen."}], ...
[p2] events seen after late join: submission, inbox_update, tool_execution_end, message_start, message_end, turn_end, turn_start, run_end, usage_changed
```

The empty `answer` in the outcome is the script's text extraction, not the package; the final assistant entry holds the text.

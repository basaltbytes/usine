# pi-durable 1.1.0 as the Pi parent runtime

Research date: 2026-10-08. Sources: the [announcement](https://earendil.com/posts/pi-durable), the published `@earendil-works/pi-durable@1.1.0` package (README, CHANGELOG, type declarations), `packages/durable/docs/spec.md` and the examples in the [pi repo](https://github.com/earendil-works/pi), the experimental durable coding agent at `packages/coding-agent/src/experimental/durable`, and a crash-and-resume experiment against the package (appendix).

## Finding

pi-durable is a single-process agent harness over one storage. It commits conversations, model turns, tool calls, and host documents atomically before showing them, and a reopened storage continues unfinished work from its last checkpoint. It has SQLite (Node and Cloudflare Durable Object), JSONL, and memory backends with a conformance suite for custom ones; a durable task state machine with ownership and bottom-up abort; an inbox (steer, follow-up, write) for busy conversations; per-conversation agent configuration stored as names; and `watch()` (structural view operations) and `watchEvents()` (coding-agent style events), which late joiners attach to without replay.

It replaces usine's **attempt channel, run host, transcript store, Pi parent session plumbing, and run-lifecycle Effect workflow**, and adds attempt resume after an orchestrator crash, late-join and multi-client observation, and interventions as ordinary submissions. It does **not** replace the larger part of the code: the child harness backends (Claude Agent SDK, Codex app-server, Pi child), the executor's worktree, credential, and salvage work, triggers, the event ledger, item and event rows, and the web UI.

Adopting it moves the Pi parent from the worker into the orchestrator, and workers run only children. The run lifecycle becomes a pi-durable task on the same storage, so one durable substrate stores runs, attempts, and conversations.

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

usine pins `@earendil-works/pi-coding-agent 0.85.1`, which depends on `pi-ai ^0.85.1`; pi-durable needs `pi-ai ^1.1.0`. To share one `pi-ai`, upgrade the coding-agent SDK first: it reached 1.1.0 the same day, with a 6,200-line changelog since 0.85. Version 1.1.0 still exports `ModelRuntime.create`, which usine's `sdk.ts` uses for API-key and ChatGPT OAuth resolution, and pi-ai 1.1 still has the `anthropic` and `openai-codex` providers.

## Mapping to usine concepts

| usine today | pi-durable equivalent | Notes |
|---|---|---|
| Pi parent `AgentSession` in the run host, driven through `session.ts`, `conversation.ts`, `turns.ts` | a task-owned `Conversation` with `instructions`, `model`, and the subagent tool selected | `configure()` stores names; the registry supplies code |
| Attempt channel protocol v7 (NDJSON over stdio or SSH) | none: tool calls commit their intent and output to storage every 100 ms | storage replaces the channel |
| Transcript rows appended as envelopes arrive | conversation entries plus `pi.live` document | `watchEvents()` yields `message_start`, `tool_execution_update`, `inbox_update`, ... |
| Run drawer live tail and history | `watch()` or `watchEvents()` snapshot plus deltas; a slow client gets a fresh snapshot after 100 frames | |
| Steer | `submit({ whenBusy: "steer" })`, placed after the current tool round | verified in the experiment |
| Interrupt (pause until guidance) | `abort()` the conversation then `submit()` guidance, or a blocking `beforeTool` hook | no one-call primitive |
| Operator message to a child, hold, release | `submit()` to the child conversation; the subagent tool checks a hold document before returning | the `23-subagent-background` example shows the reporter and request-id pattern |
| Child session events under the parent | the subagent call's `details` contains the child conversation id; clients attach to it | the experimental durable TUI does this |
| Cancel and supersede | `harness.abortTask()` on the run task aborts owned work bottom-up: child tool call, then conversation, then the task's abort handler | documented and tested upstream; not exercised in the experiment |
| Approval as a consumed event | a task phase that watches an approval document, which the operator commits from outside | verified in the experiment |
| Retry as a new attempt | a new checkpoint in the run task, with a new `requestId` for the parent submission | `requestId` makes the submission exactly-once across restarts |
| Crash mid-attempt: new attempt from scratch | the tool call that spawned the child gets an `interrupted` result with its committed output; the parent model continues and can resume the child by the native session id usine already records | the main gain |
| Pool usage from `SessionTokensUpdated` events | `pi.usage` per conversation and `harness.usage()`; tool results can report usage | children's own meters still come from the child backends |
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

The parent's only tool is the subagent tool, so it needs no `ExecutionEnv`, and the worker seam shrinks to "spawn a harness child here and give me its stdio": a child process locally, and on exe.dev the SSH exec the executor already runs for the run host. The Agent SDK launches the Claude child with `pathToClaudeCodeExecutable: "claude"`, which would point at an SSH wrapper. The Codex child already speaks JSON-RPC over a spawned process's stdio and only needs its spawn to use the transport. Pi children would run in the orchestrator's harness as plain owned conversations.

The Pi parent's API key or ChatGPT OAuth stays with the orchestrator, children use the worker's login state, and no secret is sent on a channel.

## Experiment results

The appendix script runs a `usine.run` task through `gate -> attempt -> settle`, with an approval document committed from outside and a task-owned parent conversation. Its `harness_child` tool isn't replay-safe and calls `process.exit(3)` after committing two output lines.

- The task waited in `gate` until the approval document changed, then created the parent conversation and submitted the attempt with `requestId: attempt:<task>:1`.
- The process died inside the tool call, leaving the task `pending` at checkpoint `{ phase: "attempt", attempt: 1 }`.
- A new process on the same SQLite file attached `watchEvents()` to the parent before resuming and got the snapshot `[pi.user, pi.system, pi.assistant]`.
- `resume()` re-entered the `attempt` phase, found the same conversation through task ownership and the same submission (id 16) through its `requestId`, and ended the tool call as `interrupted`, keeping its two output lines.
- An operator steer sent during the attempt became the next user turn after the tool round, before the final answer.
- The task completed; `harness.usage()` reported the two model calls.

Two mistakes in the script's first draft that usine code is likely to repeat:

- A `runtime.commit` callback returns the task's next state. Returning a conversation id from it corrupted the task row, and the failed commit poisoned the Session for every later call until reopen.
- `watchDoc()` returns `undefined` for a document that no commit has created yet, so create the document in an intent commit before you watch it.

## Risks

- **API churn.** Two breaking releases in the first week: pin exactly, as with every Pi package, and budget for migrations.
- **One Session, one process.** One bad commit from any extension poisons the Session for every running conversation, so the orchestrator needs a reopen supervisor, and extensions need typed boundaries like other code.
- **No forced termination in-process.** Killing a tool that ignores its abort signal means killing the orchestrator. The parent's only tool delegates to a remote process that the transport can kill.
- **Two SQLite connections, one file.** usine's rows (items, events, workers, projections) stay under drizzle; runs, attempts, and conversations move to pi-durable storage. A usine row and a pi-durable commit are never one transaction, so ADR 0010's projection-plus-startup-sweep pattern stays for usine's rows.
- **Web UI rework.** The run drawer, ADR 0025's bookmarks, and the transcript reader use transcript sequences and attempt/session/call ids, and would read conversation entries and `watchEvents()` instead.
- **Remote child spawn.** The Agent SDK over an SSH wrapper is unverified. If it fails, the exe.dev adapter would drive the Claude CLI's stream-json mode over SSH.
- **Cloudflare.** The Durable Object adapter suits a one-writer harness, but spawning children on a worker from a Durable Object needs a worker-side agent protocol that doesn't exist yet. The local and exe.dev targets don't need it.

## Recommendation

Adopt pi-durable as the single durable substrate. usine has no users, so a staged migration beside the Effect workflow protects no one. Order of work:

1. **Upgrade the Pi packages to 1.1.0** on their own (`pi-coding-agent`, `pi-ai`, `chord`), to share `pi-ai` and keep the SDK migration separate from the architecture change.
2. **Run as a pi-durable task** (gate, attempt, settle, as in the appendix) that owns the parent conversation. The subagent tool spawns the existing Claude and Codex backends through a local child-spawn transport, the run drawer reads `watchEvents()`, and interventions become submissions as in the mapping table. Check: an orchestrator restart during an attempt resumes it instead of opening a new one.
3. **exe.dev transport**, after verifying the Agent SDK over an SSH wrapper.
4. **Delete** the run host package, protocol v7, the transcript store, the parent-side session plumbing in `@usine/agents`, the Effect workflow, and the cluster tables.

ADRs to amend, each with a dated entry giving the new why: 0003 (run durability is a pi-durable task), 0006 (run host and attempt channel become the child-spawn transport; reattach is in), 0018 (interventions as submissions), 0010 (two SQLite connections, one file), 0005 (the subagents extension becomes a pi-durable extension).

## Outcome (2026-10-11)

Steps 1 to 4 merged to main in PRs #188, #194, #202, #206, and #208, with two departures from the plan:

- The pi-durable task is the attempt (`usine.attempt`), not the run: a run task would add a second task type for a dozen lines of state machine whose state is already in usine's tables. The run loop (approval gate, worker reserve, attempt, finish decision, continuation) is an engine fiber over the run tables with a startup reconcile. The Effect workflow, the workflow commands table, and the cluster tables are gone (ADR 0003 amendment).
- The transcript store stays. Claude Code and Codex children run outside the harness, so their events reach storage only through the relay that appends attempt channel envelopes to `usine_attempt_transcripts`; pi-durable's conversation entries contain only the parent. The run drawer still reads the transcript, so `PROTOCOL_VERSION` stays on the envelopes.

Dogfooded on the factory instance: after a SIGKILL mid-attempt and a restart, the same attempt reattaches and the run finishes on it; cancel stops the parent task and its child with no orphan; the approval gate waits and resumes. Follow-ups are on the issues linked from #176.

## Appendix: experiment script

Run with pi-durable, pi-ai, and chord 1.1.0 installed beside it:

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

The empty `answer` in the outcome comes from the script's text extraction, not the package; the final assistant entry contains the text.

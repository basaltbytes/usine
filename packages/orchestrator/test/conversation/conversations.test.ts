import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { ExecShell } from "@usine/agents/child-host";
import { catalog, HarnessCatalog, supervisor, supervisorAgent } from "@usine/agents/harness";
import type { NativeSession, Start } from "@usine/agents/harness/contract";
import { Harnesses } from "@usine/agents/harness/registry";
import type { HarnessRuntime } from "@usine/agents/harness/node";
import { SessionResult, WorkingDirectory } from "@usine/agents/runtime";
import {
  runSupervisorTurn,
  SupervisorSandbox,
  type SupervisorSandboxService,
  SupervisorSeat,
  SupervisorUnavailable,
} from "@usine/agents/supervisor";
import { UsineConfig } from "@usine/config/factory";
import { LoadedInstance } from "@usine/config/instance";
import {
  GitHubUserId,
  PermissionGrant,
  permits,
  ProjectScope,
  RequestPermissions,
} from "@usine/core/access";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import {
  type AgentSessionEvent,
  HarnessSession,
  RoleSession,
  SessionStarted,
  SessionTokensUpdated,
  TextOutput,
  TokenCount,
} from "@usine/core/agent/session";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { changeBusLayer } from "@usine/core/changes";
import {
  PostedWithSession,
  turnGrants,
  AnchorKind,
  AnchorReference,
  defaultFormat,
  MessageBody,
  MessageSequence,
  type Turn,
  TurnMember,
} from "@usine/core/conversation";
import { OperatorLogin } from "@usine/core/operator";
import { CallTarget, OperationCall, OperationName } from "@usine/core/permission-request";
import { ProjectId } from "@usine/core/project";
import { WorkerName } from "@usine/core/worker";
import {
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect";
import { Toolkit } from "effect/ai";
import { TurnAccess, TurnAccessError } from "../../src/conversation/access.ts";
import {
  type ConversationRequest,
  Conversations,
  conversationsLayer,
} from "../../src/conversation/conversations.ts";
import { memoryConversationStoreLayer } from "../../src/conversation/memory.ts";
import { ActingCalls } from "../../src/conversation/permissions/acting.ts";
import { memoryPermissionStoreLayer } from "../../src/conversation/permissions/memory.ts";
import { Permissions, permissionsLayer } from "../../src/conversation/permissions/permissions.ts";
import { PermissionStore } from "../../src/conversation/permissions/store.ts";
import { ConversationStore } from "../../src/conversation/store.ts";
import { SupervisorSourceTrees } from "../../src/supervisor-sandbox.ts";
import { fixedInstanceLayer } from "../support/current-instance.ts";

const project = ProjectScope.make({ project: ProjectId.make("factory") });
const ada = TurnMember.make({ id: GitHubUserId.make(7), login: OperatorLogin.make("ada") });
const grace = TurnMember.make({ id: GitHubUserId.make(8), login: OperatorLogin.make("grace") });
const operator = [
  PermissionGrant.make({ permission: "read", scope: project }),
  PermissionGrant.make({ permission: "operate", scope: project }),
];
const viewer = [PermissionGrant.make({ permission: "read", scope: project })];
const as = (member: TurnMember) => ({ member, credential: PostedWithSession.make({}) });
const brain = BrainSpec.make({
  harness: Harness.make("claude"),
  model: ModelId.make("claude-sonnet-5-5"),
  effort: "low",
});

type Settings = NonNullable<(typeof UsineConfig.Encoded)["settings"]>;

const instance = (settings: Settings) =>
  Effect.map(
    Schema.decodeEffect(UsineConfig)({
      version: 2,
      repos: [{ name: "acme/app" }],
      projects: [{ id: "factory", name: "Factory", repositories: ["acme/app"] }],
      settings,
    }),
    (config) =>
      LoadedInstance.make({
        config,
        agents: [],
        invalidAgents: [],
        loops: [],
        quarantinedLoops: [],
        warnings: [],
      }),
  ).pipe(Effect.orDie);

const container = { runtime: "docker", name: "test-container" };
const seat = SupervisorSeat.make({
  host: Object.assign(
    ExecShell.make({
      destination: "test-container",
      container,
      transport: { run: () => Effect.die("The scripted harness runs no command") },
    }),
    { container },
  ),
  worker: WorkerName.make("orchestrator"),
  cwd: WorkingDirectory.make("/conversation"),
  environment: {},
  credential: "gateway",
  restored: true,
});

/** One scripted turn: its events, its answer, and a gate that holds the answer until opened. */
interface Script {
  readonly events: ReadonlyArray<string>;
  readonly answer: string;
  readonly tokens: number;
  readonly gate: Option.Option<Deferred.Deferred<void>>;
}

/**
 * A Claude Code runtime whose sessions play `scripts` in order. Each session reports its saved
 * conversation, its texts, and its usage, then answers once its gate opens. `starts` collects how
 * each session started.
 */
const scriptedHarness = (scripts: Array<Script>, starts: Array<Start>) => {
  const runtime: HarnessRuntime = {
    id: brain.harness,
    open: (spec, start) =>
      Effect.sync((): NativeSession => {
        starts.push(start);
        const script = scripts.shift();
        if (script === undefined) throw new Error("No scripted turn is left");
        const session = RoleSession.make({
          id: spec.session.id,
          role: supervisor.name,
          agent: supervisorAgent,
          brain,
        });
        const events: ReadonlyArray<AgentSessionEvent> = [
          SessionStarted.make({
            session,
            harnessSession: Option.some(HarnessSession.make({ cwd: "/conversation" })),
          }),
          ...script.events.map((text) => TextOutput.make({ session, text })),
          SessionTokensUpdated.make({ session, totalTokens: TokenCount.make(script.tokens) }),
        ];
        return {
          running: {
            session,
            events: Stream.fromIterable(events),
            result: Option.match(script.gate, {
              onNone: () => Effect.void,
              onSome: Deferred.await,
            }).pipe(Effect.as(SessionResult.make({ message: script.answer }))),
            steer: () => Effect.void,
            interrupt: Effect.void,
            intervene: () =>
              Effect.succeed(AttemptChannel.InterventionState.make({ held: false, paused: false })),
          },
          active: false,
          recover: () => Effect.void,
        };
      }),
    complete: () => Effect.die("The supervisor turn calls only open"),
    stop: () => Effect.die("The supervisor turn calls only open"),
    preflight: () => Effect.die("The supervisor turn calls only open"),
  };
  return Harnesses.layerFrom(
    HarnessCatalog.make({
      descriptors: catalog.descriptors.filter(({ id }) => id === brain.harness),
    }),
    [runtime],
  );
};

const available: SupervisorSandboxService = {
  unavailable: Effect.succeedNone,
  checked: Effect.succeedNone,
  open: () => Effect.succeed(seat),
  save: () => Effect.void,
};

/**
 * Gives every turn the poster's `grants`, three needs, and no operator tools, or refuses it with
 * `refused`, as for a revoked token. A turn's session first sends each of `calls` to the turn's
 * requests, as a tool call would, and `prompts` collects each turn's message.
 */
const access = (
  grants: Ref.Ref<ReadonlyArray<PermissionGrant>>,
  refused: Ref.Ref<Option.Option<string>>,
  calls: Ref.Ref<ReadonlyArray<OperationCall>>,
  prompts: Array<string>,
) =>
  Layer.succeed(TurnAccess)({
    open: (_member, _credential, scope, requests) =>
      Effect.gen(function* () {
        const refusal = yield* Ref.get(refused);
        if (Option.isSome(refusal)) return yield* TurnAccessError.make({ message: refusal.value });
        const current = yield* Ref.get(grants);
        return {
          posterGrants: current,
          grants: turnGrants(scope, current),
          needsYou: ['{"_tag":"ApprovalNeed","runId":"run-1"}'],
          needsTotal: 3,
          run: (turn, observe) =>
            Effect.gen(function* () {
              prompts.push(turn.message);
              const pending = yield* Ref.getAndSet(calls, []);
              yield* Effect.forEach(pending, (call, index) =>
                requests.call(call, Option.some(`call-${index}`)).pipe(Effect.orDie),
              );
              return yield* runSupervisorTurn(turn, Toolkit.empty, observe);
            }),
        };
      }),
  });

interface Setup {
  readonly scripts: Array<Script>;
  readonly settings?: Settings;
  readonly sandbox?: SupervisorSandboxService;
}

/** Runs each allowed call as a success, records it, and gives each member `grants`. */
const acting = (grants: Ref.Ref<ReadonlyArray<PermissionGrant>>, ran: Array<OperationCall>) =>
  Layer.succeed(ActingCalls)({
    access: () =>
      Effect.map(Ref.get(grants), (current) => ({
        permits: ({ permission, scope }) => permits(current, permission, scope),
      })),
    run: (_actor, call) =>
      Effect.sync(() => {
        ran.push(call);
        return { _tag: "Succeeded" as const, result: '{"ok":true}' };
      }),
  });

/**
 * The conversations of one orchestrator process on `store`, with a scripted harness. Building it
 * again on the same store is a restart.
 */
const conversations = (store: Layer.Layer<ConversationStore | PermissionStore>, setup: Setup) =>
  Effect.gen(function* () {
    const starts: Array<Start> = [];
    const prompts: Array<string> = [];
    const ran: Array<OperationCall> = [];
    const grants = yield* Ref.make<ReadonlyArray<PermissionGrant>>(operator);
    const refused = yield* Ref.make(Option.none<string>());
    const calls = yield* Ref.make<ReadonlyArray<OperationCall>>([]);
    const loaded = yield* instance(setup.settings ?? { supervisor: brain });
    const layer = conversationsLayer.pipe(
      Layer.provideMerge(permissionsLayer),
      Layer.provide(
        Layer.mergeAll(
          store,
          access(grants, refused, calls, prompts),
          acting(grants, ran),
          scriptedHarness(setup.scripts, starts),
          fixedInstanceLayer(loaded),
          Layer.succeed(SupervisorSourceTrees)({ prepare: () => Effect.succeed([]) }),
          changeBusLayer,
          NodeServices.layer,
        ),
      ),
      Layer.provide(Layer.succeed(SupervisorSandbox, setup.sandbox ?? available)),
    );
    return { layer, starts, grants, refused, calls, prompts, ran };
  });

const message = (text: string) => ({
  body: MessageBody.make(text),
  format: defaultFormat,
  reply: defaultFormat,
});
const request = (text: string): ConversationRequest => ({
  scope: project,
  anchor: Option.some({
    kind: AnchorKind.make("map-pin/v9"),
    reference: AnchorReference.make("tile 4:7"),
  }),
  title: Option.none(),
  message: message(text),
});

const script = (answer: string, gate = Option.none<Deferred.Deferred<void>>()): Script => ({
  events: [`Working on: ${answer}`],
  answer,
  tokens: answer.length * 10,
  gate,
});

/** Waits until the stored conversation satisfies `done`. */
const until = (
  conversation: Parameters<Conversations["Service"]["read"]>[0],
  done: (turns: ReadonlyArray<Turn>) => boolean,
) =>
  Effect.gen(function* () {
    const service = yield* Conversations;
    while (true) {
      const record = yield* service.read(conversation);
      if (done(record.turns)) return record;
      yield* Effect.sleep("5 millis");
    }
  }).pipe(Effect.timeout("5 seconds"), Effect.orDie);

/** One in-memory store; layers built on it again share its records, as a restart does. */
const memoryStore = Effect.map(
  Layer.build(Layer.merge(memoryConversationStoreLayer, memoryPermissionStoreLayer)),
  (context) => Layer.succeedContext(context),
);

/** Waits until the conversation has stored `count` events. */
const eventsStored = (
  conversation: Parameters<Conversations["Service"]["read"]>[0],
  count: number,
) =>
  Effect.gen(function* () {
    const service = yield* Conversations;
    while (true) {
      const events = yield* service.events(conversation, 0, 100);
      if (events.length >= count) return;
      yield* Effect.sleep("5 millis");
    }
  }).pipe(Effect.timeout("5 seconds"), Effect.orDie);

const states = (turns: ReadonlyArray<Turn>) => turns.map(({ state }) => state._tag);
const asOperator = Effect.provideService(RequestPermissions, operator);

describe("conversations with the supervisor", () => {
  it.live("queues a message posted during a running turn and runs it after", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const store = yield* memoryStore;
      const { layer, starts } = yield* conversations(store, {
        scripts: [script("first answer", Option.some(gate)), script("second answer")],
      });
      yield* Effect.gen(function* () {
        const service = yield* Conversations;
        const started = yield* service.start(request("What needs me?"), as(ada));
        const id = started.conversation.id;
        yield* until(id, (turns) => turns[0]?.state._tag === "Running");
        const posted = yield* service.post(id, message("And then?"), as(grace));
        assert.strictEqual(posted.turn.state._tag, "Queued");
        assert.deepStrictEqual(posted.turn.credential, PostedWithSession.make({}));
        const waiting = yield* service.read(id);
        assert.deepStrictEqual(states(waiting.turns), ["Running", "Queued"]);
        yield* Deferred.succeed(gate, undefined);
        const done = yield* until(id, (turns) =>
          turns.every(({ state }) => state._tag === "Succeeded"),
        );
        assert.deepStrictEqual<ReadonlyArray<ReadonlyArray<unknown>>>(
          done.messages.map(({ role, body }) => [role, body]),
          [
            ["member", "What needs me?"],
            ["member", "And then?"],
            ["supervisor", "first answer"],
            ["supervisor", "second answer"],
          ],
        );
        assert.deepStrictEqual(
          done.turns.map(({ member }) => member.login),
          ["ada", "grace"],
        );
        assert.deepStrictEqual(
          starts.map(({ _tag }) => _tag),
          ["StartPrompt", "StartResume"],
        );
        const events = yield* service.events(id, 0, 100);
        assert.deepStrictEqual(
          events.map(({ sequence }) => sequence),
          events.map((_, index) => index + 1),
        );
        assert.deepStrictEqual(
          events.flatMap(({ event }) => (event._tag === "TextOutput" ? [event.text] : [])),
          ["Working on: first answer", "Working on: second answer"],
        );
      }).pipe(asOperator, Effect.provide(layer));
    }).pipe(Effect.scoped),
  );

  for (const [name, refuse] of [
    [
      "fails a queued turn whose poster can no longer operate on the scope",
      ({ grants }: { readonly grants: Ref.Ref<ReadonlyArray<PermissionGrant>> }) =>
        Ref.set(grants, viewer),
    ],
    [
      "fails a queued turn whose posting token was revoked",
      ({ refused }: { readonly refused: Ref.Ref<Option.Option<string>> }) =>
        Ref.set(refused, Option.some("The token that posted this message was revoked.")),
    ],
  ] as const)
    it.live(name, () =>
      Effect.gen(function* () {
        const store = yield* memoryStore;
        const gate = yield* Deferred.make<void>();
        const setup = yield* conversations(store, {
          scripts: [script("first answer", Option.some(gate))],
        });
        yield* Effect.gen(function* () {
          const service = yield* Conversations;
          const started = yield* service.start(request("First"), as(ada));
          const id = started.conversation.id;
          yield* until(id, (turns) => turns[0]?.state._tag === "Running");
          yield* service.post(id, message("Second"), as(ada));
          yield* refuse(setup);
          yield* Deferred.succeed(gate, undefined);
          const done = yield* until(id, (turns) => turns[1]?.state._tag === "Failed");
          const failed = done.turns[1]?.state;
          assert.deepStrictEqual(
            failed?._tag === "Failed" && failed.failure._tag === "TurnError"
              ? failed.failure.message
              : failed?._tag,
            name.includes("revoked")
              ? "The token that posted this message was revoked."
              : "ada can no longer operate on project factory, so the turn didn't run.",
          );
          assert.deepStrictEqual(
            done.messages.map(({ role }) => role),
            ["member", "member", "supervisor"],
          );
        }).pipe(asOperator, Effect.provide(setup.layer));
      }).pipe(Effect.scoped),
    );

  it.live("fails a turn that was running at a restart and runs the queued one", () =>
    Effect.gen(function* () {
      const store = yield* memoryStore;
      const never = yield* Deferred.make<void>();
      const before = yield* conversations(store, { scripts: [script("lost", Option.some(never))] });
      const first = yield* Scope.make();
      const running = yield* Layer.buildWithScope(before.layer, first);
      const id = yield* Effect.gen(function* () {
        const service = yield* Conversations;
        const started = yield* service.start(request("Long question"), as(ada));
        yield* until(started.conversation.id, (turns) => turns[0]?.state._tag === "Running");
        yield* service.post(started.conversation.id, message("Queued question"), as(ada));
        // The usage report reaches the store before the process stops.
        yield* eventsStored(started.conversation.id, 3);
        return started.conversation.id;
      }).pipe(asOperator, Effect.provideContext(running));
      yield* Scope.close(first, Exit.void);
      const stored = yield* Effect.service(ConversationStore).pipe(
        Effect.flatMap((current) => current.get(id)),
        Effect.provide(store),
      );
      assert.deepStrictEqual(
        Option.map(stored, ({ turns }) => states(turns)),
        Option.some(["Running", "Queued"]),
      );
      const after = yield* conversations(store, { scripts: [script("answered after restart")] });
      yield* Effect.gen(function* () {
        const done = yield* until(id, (turns) => turns[1]?.state._tag === "Succeeded");
        const interrupted = done.turns[0]?.state;
        assert.strictEqual(interrupted?._tag, "Failed");
        if (interrupted?._tag === "Failed") {
          assert.strictEqual(interrupted.failure._tag, "Interrupted");
          assert.deepStrictEqual(
            Option.map(interrupted.usage, ({ totalTokens }) => totalTokens),
            Option.some(40),
          );
        }
        assert.deepStrictEqual<ReadonlyArray<ReadonlyArray<unknown>>>(
          done.messages.map(({ role, body }) => [role, body]),
          [
            ["member", "Long question"],
            ["member", "Queued question"],
            ["supervisor", "answered after restart"],
          ],
        );
      }).pipe(asOperator, Effect.provide(after.layer));
      assert.deepStrictEqual(
        after.starts.map(({ _tag }) => _tag),
        ["StartPrompt"],
      );
    }).pipe(Effect.scoped),
  );

  it.live("cancels a running turn and keeps its events, and cancels a queued one", () =>
    Effect.gen(function* () {
      const store = yield* memoryStore;
      const never = yield* Deferred.make<void>();
      const { layer } = yield* conversations(store, {
        scripts: [script("never", Option.some(never)), script("unused")],
      });
      yield* Effect.gen(function* () {
        const service = yield* Conversations;
        const started = yield* service.start(request("Long question"), as(ada));
        const id = started.conversation.id;
        yield* until(id, (turns) => turns[0]?.state._tag === "Running");
        const queued = yield* service.post(id, message("Never mind"), as(ada));
        const canceledQueued = yield* service.cancel(id, queued.turn.id, ada.login);
        assert.strictEqual(canceledQueued.state._tag, "Canceled");
        yield* eventsStored(id, 3);
        const running = started.turns[0];
        if (running === undefined) return assert.fail("The conversation has no turn");
        const canceled = yield* service.cancel(id, running.id, grace.login);
        assert.strictEqual(canceled.state._tag, "Canceled");
        if (canceled.state._tag === "Canceled") {
          assert.strictEqual(canceled.state.by, "grace");
          assert.isTrue(Option.isSome(canceled.state.startedAt));
          assert.deepStrictEqual(
            Option.map(canceled.state.usage, ({ totalTokens }) => totalTokens),
            Option.some(50),
          );
        }
        const record = yield* service.read(id);
        assert.deepStrictEqual(states(record.turns), ["Canceled", "Canceled"]);
        const events = yield* service.events(id, 0, 10);
        assert.deepStrictEqual(
          events.map(({ event }) => event._tag),
          ["SessionStarted", "TextOutput", "SessionTokensUpdated"],
        );
      }).pipe(asOperator, Effect.provide(layer));
    }).pipe(Effect.scoped),
  );

  it.live(
    "lets a viewer read a project conversation, mark it read, and refuses the viewer's post",
    () =>
      Effect.gen(function* () {
        const store = yield* memoryStore;
        const { layer } = yield* conversations(store, { scripts: [script("ok")] });
        yield* Effect.gen(function* () {
          const service = yield* Conversations;
          const started = yield* service.start(request("Hello"), as(ada)).pipe(asOperator);
          const id = started.conversation.id;
          const asViewer = Effect.provideService(RequestPermissions, viewer);
          const read = yield* service.read(id).pipe(asViewer);
          assert.strictEqual(read.conversation.id, id);
          const listed = yield* service.list(Option.none(), Option.some(grace.id)).pipe(asViewer);
          assert.deepStrictEqual(
            listed.map(({ conversation, unread }) => [conversation.id, unread]),
            [[id, Option.some(true)]],
          );
          const marker = yield* service
            .markRead(id, MessageSequence.make(99), grace.id)
            .pipe(asViewer);
          assert.strictEqual(marker.through, 1);
          const afterRead = yield* service
            .list(Option.none(), Option.some(grace.id))
            .pipe(asViewer);
          assert.deepStrictEqual(
            afterRead.map(({ unread }) => unread),
            [Option.some(false)],
          );
          const refused = yield* service
            .post(id, message("Me too"), as(grace))
            .pipe(asViewer, Effect.flip);
          assert.strictEqual(refused._tag, "AccessDenied");
          const outsider = Effect.provideService(RequestPermissions, []);
          const hidden = yield* service.read(id).pipe(outsider, Effect.flip);
          assert.strictEqual(hidden._tag, "ConversationNotFound");
          const none = yield* service.list(Option.none(), Option.none()).pipe(outsider);
          assert.deepStrictEqual(none, []);
          const unmarked = yield* service
            .markRead(id, MessageSequence.make(1), grace.id)
            .pipe(outsider, Effect.flip);
          assert.strictEqual(unmarked._tag, "ConversationNotFound");
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped),
  );

  it.live(
    "fails an answered turn whose state wasn't saved, and starts a new session without state",
    () =>
      Effect.gen(function* () {
        const store = yield* memoryStore;
        const lost =
          "The conversation's home is larger than supervisor_limits.conversation_size_mib (128 MiB), so usine kept the state that the previous turn saved";
        const saves = yield* Ref.make(0);
        const opened = yield* Ref.make(0);
        const sandbox: SupervisorSandboxService = {
          ...available,
          // The second turn finds no saved state, as after the removal of an old image.
          open: () =>
            Ref.updateAndGet(opened, (count) => count + 1).pipe(
              Effect.map((count) => SupervisorSeat.make({ ...seat, restored: count === 1 })),
            ),
          save: () =>
            Ref.updateAndGet(saves, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 2
                  ? Effect.fail(SupervisorUnavailable.make({ message: lost }))
                  : Effect.void,
              ),
            ),
        };
        const { layer, starts } = yield* conversations(store, {
          scripts: [script("first answer"), script("unsaved answer")],
          sandbox,
        });
        yield* Effect.gen(function* () {
          const service = yield* Conversations;
          const started = yield* service.start(request("First"), as(ada));
          const id = started.conversation.id;
          yield* until(id, (turns) => turns[0]?.state._tag === "Succeeded");
          yield* service.post(id, message("Second"), as(ada));
          const done = yield* until(id, (turns) => turns[1]?.state._tag === "Failed");
          const failed = done.turns[1]?.state;
          assert.strictEqual(
            failed?._tag === "Failed" && failed.failure._tag === "TurnError"
              ? failed.failure.message
              : failed?._tag,
            lost,
          );
          assert.deepStrictEqual(
            done.messages.map(({ role }) => role),
            ["member", "supervisor", "member"],
          );
        }).pipe(asOperator, Effect.provide(layer));
        assert.deepStrictEqual(
          starts.map(({ _tag }) => _tag),
          ["StartPrompt", "StartPrompt"],
        );
      }).pipe(Effect.scoped),
  );

  it.live("runs an allowed call once and reports its outcome in the conversation's next turn", () =>
    Effect.gen(function* () {
      const store = yield* memoryStore;
      const setup = yield* conversations(store, {
        scripts: [script("asked for a retry"), script("the run is retrying")],
      });
      yield* Ref.set(setup.calls, [
        OperationCall.make({
          operation: OperationName.make("retry"),
          summary: "Retry a failed run",
          arguments: { runId: "run-1" },
          target: CallTarget.make("run run-1"),
          scope: project,
          permission: "operate",
        }),
      ]);
      yield* Effect.gen(function* () {
        const service = yield* Conversations;
        const permissions = yield* Permissions;
        const started = yield* service.start(request("Retry run 1"), as(ada));
        const id = started.conversation.id;
        yield* until(id, (turns) => turns[0]?.state._tag === "Succeeded");
        const [waiting] = yield* permissions.ofConversation(id, Option.some(as(grace)));
        if (waiting === undefined) return assert.fail("The turn stored no request");
        assert.deepStrictEqual([waiting.request.state._tag, waiting.answerable], ["Waiting", true]);
        assert.isEmpty(setup.ran, "nothing runs before a member answers");
        const answered = yield* service.answer(id, waiting.request.id, "once", as(grace));
        assert.strictEqual(answered.state._tag, "Ran");
        const done = yield* until(id, (turns) => turns[1]?.state._tag === "Succeeded");
        assert.deepStrictEqual(
          done.messages.map(({ role }) => role),
          ["member", "supervisor", "usine", "supervisor"],
        );
        assert.include(
          setup.prompts[1],
          "Outcomes of the permission requests of the previous turn:",
        );
        assert.include(setup.prompts[1], '"answer":"allowed once","by":"grace","outcome":"ran"');
        const again = yield* service
          .answer(id, waiting.request.id, "deny", as(grace))
          .pipe(Effect.flip);
        assert.strictEqual(again._tag, "RequestAnswered");
        assert.lengthOf(setup.ran, 1, "the allowed call ran exactly once");
      }).pipe(asOperator, Effect.provide(setup.layer));
    }).pipe(Effect.scoped),
  );

  it.live("reports a request answered while its turn runs once the turn ends", () =>
    Effect.gen(function* () {
      const store = yield* memoryStore;
      const gate = yield* Deferred.make<void>();
      const setup = yield* conversations(store, {
        scripts: [script("asked for a retry", Option.some(gate)), script("the run is retrying")],
      });
      yield* Ref.set(setup.calls, [
        OperationCall.make({
          operation: OperationName.make("retry"),
          summary: "Retry a failed run",
          arguments: { runId: "run-1" },
          target: CallTarget.make("run run-1"),
          scope: project,
          permission: "operate",
        }),
      ]);
      yield* Effect.gen(function* () {
        const service = yield* Conversations;
        const permissions = yield* Permissions;
        const started = yield* service.start(request("Retry run 1"), as(ada));
        const id = started.conversation.id;
        const waiting = yield* permissions.ofConversation(id, Option.none()).pipe(
          Effect.map(([entry]) => Option.fromUndefinedOr(entry)),
          Effect.flatMap(Effect.fromOption),
          Effect.retry(Schedule.spaced("5 millis")),
          Effect.timeout("5 seconds"),
          Effect.orDie,
        );
        yield* service.answer(id, waiting.request.id, "once", as(grace));
        const running = yield* service.read(id);
        assert.deepStrictEqual(states(running.turns), ["Running"]);
        yield* Deferred.succeed(gate, undefined);
        const done = yield* until(id, (turns) => turns[1]?.state._tag === "Succeeded");
        assert.deepStrictEqual(
          done.messages.map(({ role }) => role),
          ["member", "supervisor", "usine", "supervisor"],
        );
      }).pipe(asOperator, Effect.provide(setup.layer));
    }).pipe(Effect.scoped),
  );

  it.live("reports setup required and refuses messages without a sandbox or a supervisor", () =>
    Effect.gen(function* () {
      const store = yield* memoryStore;
      const missing = SupervisorUnavailable.make({ message: "Podman or Docker isn't installed" });
      const noSandbox: SupervisorSandboxService = {
        unavailable: Effect.succeedSome(missing),
        checked: Effect.succeedSome(missing),
        open: () => Effect.die("The test opens no sandbox"),
        save: () => Effect.die("The test opens no sandbox"),
      };
      const setups: ReadonlyArray<[Setup, string]> = [
        [{ scripts: [], sandbox: noSandbox }, "Podman or Docker isn't installed"],
        [{ scripts: [], settings: {} }, "No supervisor is configured. Set settings.supervisor."],
      ];
      for (const [setup, reason] of setups) {
        const { layer } = yield* conversations(store, setup);
        yield* Effect.gen(function* () {
          const service = yield* Conversations;
          const status = yield* service.status;
          assert.deepStrictEqual(
            status._tag === "SupervisorSetupRequired" ? status.reason : status._tag,
            reason,
          );
          const refused = yield* service.start(request("Hello"), as(ada)).pipe(Effect.flip);
          assert.strictEqual(refused._tag, "SupervisorNotReady");
        }).pipe(asOperator, Effect.provide(layer));
      }
    }).pipe(Effect.scoped),
  );
});

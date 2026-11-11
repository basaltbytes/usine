import { MachineId } from "@usine/core/worker";
import { Clock, Effect, Layer, Option, Stream } from "effect";
import {
  BoxdApi,
  BoxdCallError,
  type BoxdCreate,
  type BoxdMachine,
  type BoxdSnapshot,
} from "../../../src/ssh/provisioner/boxd/client.ts";
import { BoxdExec } from "../../../src/ssh/provisioner/boxd/exec.ts";

/** The regional API endpoint that the fake reports. */
export const BOXD_ENDPOINT = "https://fra.boxd.test:9443";

export const fakeBoxd = () => {
  const machines = new Map<MachineId, BoxdMachine>();
  const names = new Map<MachineId, string>();
  const creates: Array<BoxdCreate> = [];
  const selectors: Array<ReadonlyArray<string>> = [];
  const timers: Array<{ id: MachineId; kind: string; seconds: number }> = [];
  /** Every `SetVmEgressAllow` call, in order, with the operations before it on the same machine. */
  const egress: Array<{ id: MachineId; entries: ReadonlyArray<string>; after: Array<string> }> = [];
  const operations = new Map<MachineId, Array<string>>();
  const record = (id: MachineId, operation: string) =>
    operations.set(id, [...(operations.get(id) ?? []), operation]);
  /** Every `Exec` call of the fake's `BoxdExec`, in order. */
  const execs: Array<{ machine: MachineId; command: string }> = [];
  /** The endpoint and credential of each `BoxdExec` that the executor built. */
  const connections: Array<{ endpoint: string; credential: string }> = [];
  const state = {
    machines,
    creates,
    selectors,
    timers,
    egress,
    operations,
    execs,
    connections,
    snapshot: {
      status: "ready",
      region: "fra",
      vcpu: 2,
      memoryBytes: 8 * 1024 ** 3,
      storage: "local",
    } satisfies BoxdSnapshot,
    token: "bxd_test_key",
    region: "fra",
    maxVms: 50,
    vmCount: 0,
    reads: 0,
    provisioningReads: 0,
    createMachine: true,
    unreachable: false,
    keyRefused: false,
    createFails: Option.none<string>(),
    /** Machine names that boxd refuses with `INVALID_ARGUMENT`. */
    reservedNames: new Set<string>(),
    readFails: Option.none<string>(),
    timerFails: Option.none<string>(),
    egressFails: Option.none<string>(),
    /** Whether boxd answers `SetVmEgressAllow` with an empty list, leaving egress unrestricted. */
    egressIgnored: false,
  };
  const failure = (operation: string, code: string) =>
    BoxdCallError.make({ operation, code, message: `boxd ${operation}: ${code}` });
  const call = <A>(operation: string, run: () => Effect.Effect<A, BoxdCallError>) =>
    Effect.suspend(() =>
      state.unreachable
        ? failure(operation, "UNAVAILABLE")
        : state.keyRefused
          ? failure(operation, "UNAUTHENTICATED")
          : run(),
    );
  const timer = (kind: string) => (id: MachineId, seconds: number) =>
    call(kind, () =>
      Option.isSome(state.timerFails)
        ? failure(kind, state.timerFails.value)
        : Effect.sync(() => {
            timers.push({ id, kind, seconds });
            record(id, kind);
          }),
    );
  const api = BoxdApi.of({
    endpoint: BOXD_ENDPOINT,
    whoami: call("whoami", () => Effect.succeed({ userId: "test-user" })),
    orgMachineLimit: call("orgMachineLimit", () =>
      Effect.succeed({ maxVms: state.maxVms, vmCount: state.vmCount }),
    ),
    snapshot: () => call("snapshot", () => Effect.succeed(state.snapshot)),
    servedRegion: call("servedRegion", () => Effect.succeed(state.region)),
    createFromSnapshot: (request) =>
      call("createFromSnapshot", () =>
        Effect.gen(function* () {
          if (Option.isSome(state.createFails))
            return yield* failure("createFromSnapshot", state.createFails.value);
          if (state.reservedNames.has(request.name))
            return yield* BoxdCallError.make({
              operation: "createFromSnapshot",
              code: "INVALID_ARGUMENT",
              message: `name '${request.name}' is reserved`,
            });
          if (state.snapshot.status !== "ready")
            return yield* failure("createFromSnapshot", "FAILED_PRECONDITION");
          if ([...names.values()].includes(request.name))
            return yield* failure("createFromSnapshot", "ALREADY_EXISTS");
          creates.push(request);
          const id = MachineId.make(`boxd-${creates.length}`);
          const now = yield* Clock.currentTimeMillis;
          const machine: BoxdMachine = {
            id,
            status: state.provisioningReads > 0 ? "starting" : "running",
            createdAt: Math.floor(now / 1000),
            labels: request.labels,
            egressAllow: [],
          };
          machines.set(id, machine);
          names.set(id, request.name);
          record(id, "create");
          return { id, machine: state.createMachine ? Option.some(machine) : Option.none() };
        }),
      ),
    vm: (id) =>
      call("vm", () =>
        Effect.gen(function* () {
          state.reads++;
          if (Option.isSome(state.readFails)) return yield* failure("vm", state.readFails.value);
          const machine = machines.get(id);
          if (machine === undefined) return yield* failure("vm", "NOT_FOUND");
          return {
            ...machine,
            status:
              state.provisioningReads-- > 0
                ? "starting"
                : machine.status === "starting"
                  ? "running"
                  : machine.status,
          };
        }),
      ),
    listVms: (selector) =>
      call("listVms", () =>
        Effect.sync(() => {
          selectors.push(selector);
          return [...machines.values()].filter((machine) =>
            selector.every((entry) => {
              const [key = "", value] = entry.split("=");
              return machine.labels[key] === value;
            }),
          );
        }),
      ),
    updateLabels: (id, set) =>
      call("updateLabels", () =>
        Effect.gen(function* () {
          const machine = machines.get(id);
          if (machine === undefined) return yield* failure("updateLabels", "NOT_FOUND");
          machines.set(id, { ...machine, labels: { ...machine.labels, ...set } });
        }),
      ),
    destroy: (id) =>
      call("destroy", () => {
        names.delete(id);
        return machines.delete(id) ? Effect.void : failure("destroy", "NOT_FOUND");
      }),
    setEgressAllow: (id, entries) =>
      call("setEgressAllow", () =>
        Effect.gen(function* () {
          if (Option.isSome(state.egressFails))
            return yield* failure("setEgressAllow", state.egressFails.value);
          const machine = machines.get(id);
          if (machine === undefined) return yield* failure("setEgressAllow", "NOT_FOUND");
          egress.push({ id, entries, after: [...(operations.get(id) ?? [])] });
          record(id, "egress");
          const inEffect = state.egressIgnored ? [] : [...entries];
          machines.set(id, { ...machine, egressAllow: inEffect });
          return inEffect;
        }),
      ),
    setAutoHibernateTimeout: timer("hibernate"),
    setAutoSuspendTimeout: timer("suspend"),
  });
  /** Answers every `Exec` call with exit code 0 and no output, and records it in `state.execs`. */
  const exec = BoxdExec.of({
    exec: (machine, command) =>
      Effect.sync(() => {
        state.execs.push({ machine, command });
        return { stdout: Stream.empty, stderr: Stream.empty, exitCode: Effect.succeed(0) };
      }),
  });
  const execLayer = Layer.succeed(BoxdExec, exec);
  return { state, api, execLayer, layer: Layer.merge(Layer.succeed(BoxdApi, api), execLayer) };
};

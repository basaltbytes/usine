import { MachineId } from "@usine/core/worker";
import { Clock, Effect, Layer, Option } from "effect";
import {
  BoxdApi,
  BoxdCallError,
  type BoxdCreate,
  type BoxdMachine,
  type BoxdSnapshot,
} from "../../../src/ssh/provisioner/boxd/client.ts";

export const fakeBoxd = () => {
  const machines = new Map<MachineId, BoxdMachine>();
  const creates: Array<BoxdCreate> = [];
  const selectors: Array<ReadonlyArray<string>> = [];
  const timers: Array<{ id: MachineId; kind: string; seconds: number }> = [];
  const state = {
    machines,
    creates,
    selectors,
    timers,
    snapshot: {
      status: "ready",
      region: "fra",
      vcpu: 2,
      memoryBytes: 8 * 1024 ** 3,
    } satisfies BoxdSnapshot,
    token: "bxd_test_key",
    region: "fra",
    maxVms: 50,
    vmCount: 0,
    hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeBoxdProxyHostKey",
    hostKeyReads: 0,
    reads: 0,
    provisioningReads: 0,
    createMachine: true,
    unreachable: false,
    keyRefused: false,
    createFails: Option.none<string>(),
    readFails: Option.none<string>(),
    timerFails: Option.none<string>(),
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
          }),
    );
  const api = BoxdApi.of({
    whoami: call("whoami", () => Effect.succeed({ userId: "test-user" })),
    orgMachineLimit: call("orgMachineLimit", () =>
      Effect.succeed({ maxVms: state.maxVms, vmCount: state.vmCount }),
    ),
    snapshot: () => call("snapshot", () => Effect.succeed(state.snapshot)),
    regions: call("regions", () => Effect.succeed({ thisRegion: state.region })),
    createFromSnapshot: (request) =>
      call("createFromSnapshot", () =>
        Effect.gen(function* () {
          if (Option.isSome(state.createFails))
            return yield* failure("createFromSnapshot", state.createFails.value);
          if (state.snapshot.status !== "ready")
            return yield* failure("createFromSnapshot", "FAILED_PRECONDITION");
          creates.push(request);
          const id = MachineId.make(`boxd-${creates.length}`);
          const now = yield* Clock.currentTimeMillis;
          const machine: BoxdMachine = {
            id,
            publicIp: "198.51.100.40",
            sshPort: 12001,
            sshDisabled: false,
            status: state.provisioningReads > 0 ? "starting" : "running",
            createdAt: Math.floor(now / 1000),
            labels: request.labels,
          };
          machines.set(id, machine);
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
    sshHostKey: call("sshHostKey", () =>
      Effect.gen(function* () {
        state.hostKeyReads++;
        if (state.hostKey === "") return yield* failure("sshHostKey", "INTERNAL");
        return state.hostKey;
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
      call("destroy", () => (machines.delete(id) ? Effect.void : failure("destroy", "NOT_FOUND"))),
    setAutoHibernateTimeout: timer("hibernate"),
    setAutoSuspendTimeout: timer("suspend"),
  });
  return { state, api, layer: Layer.succeed(BoxdApi, api) };
};

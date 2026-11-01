import { Attachments } from "@usine/gateway";
import { fakeGateway } from "../gateway/support.ts";
import { RunId } from "@usine/core/run";
import {
  ProvisionerTimings,
  ProvisionerSeconds,
  SshIdentityFile,
  WorkerRoot,
} from "@usine/core/worker";
import {
  completes,
  type StubParent,
  StubStorage,
  stubAttemptRuntime,
} from "@usine/durable/testing";

import { Effect, Layer, Option, Redacted } from "effect";
import { claudeLoginLockLayer, type AttemptConnections } from "../../../src/executor.ts";
import type { SshWorkerAddress } from "../../../src/ssh/model.ts";

import { layer as sshLayer } from "../../../src/ssh/ssh.ts";
import {
  ADDRESS,
  aloneOnItem,
  fakeMachine,
  INSTANCE,
  INSTANCE_ID,
  LOCAL_TEMPORARY_DIRECTORY,
  mintingProvider,
} from "../support.ts";
import { boatSettings, hetznerSettings } from "./support.ts";

import { BOAT_TEST_API, fakeProviders, HETZNER_TEST_API } from "./fake-providers.ts";

export const ROOT = WorkerRoot.make("/home/usine/.usine");
export const RUN = RunId.make("remote-run");
export const KEY = "sk-ant-api-for-provisioned-tests";

/** A provisioned Hetzner Worker without a Gateway, whose Attempts get an Anthropic API key. */
export const hetznerAddress: SshWorkerAddress = {
  ...ADDRESS,
  port: Option.none(),
  root: ROOT,
  machine: {
    _tag: "Provisioned",
    provisioner: hetznerSettings({
      network: Option.none(),
      timings: new ProvisionerTimings({ sshWait: ProvisionerSeconds.make(1) }),
      apiKeys: { anthropic: Option.some(Redacted.make(KEY)), openai: Option.none() },
    }),
  },
};

export const boatAddress: SshWorkerAddress = {
  ...ADDRESS,
  port: Option.none(),
  root: WorkerRoot.make("/home/user/.usine"),
  identityFile: Option.some(SshIdentityFile.make("/keys/usine_boat")),
  machine: {
    _tag: "Provisioned",
    provisioner: boatSettings({
      timings: new ProvisionerTimings({ sshWait: ProvisionerSeconds.make(1) }),
    }),
  },
};

export const sink = {
  append: () => Effect.void,
  salvage: () => Effect.void,
  comments: () => Effect.void,
  outOfMemory: () => Effect.void,
  transcript: Effect.succeed([]),
  windows: aloneOnItem(),
};

export const runtimeOf = (
  machine: ReturnType<typeof fakeMachine>,
  providers: ReturnType<typeof fakeProviders>,
  address: SshWorkerAddress,
  {
    parent = completes,
    storage = new StubStorage(),
    ...connectionOptions
  }: {
    readonly parent?: StubParent;
    readonly storage?: StubStorage;
    readonly attemptConnections?: AttemptConnections<SshWorkerAddress>;
  } = {},
) =>
  sshLayer({
    workers: [address],
    ...connectionOptions,
    instance: INSTANCE,
    instanceId: INSTANCE_ID,
    interruptGrace: "2 seconds",
    providerEndpoints: { hetzner: HETZNER_TEST_API, boat: BOAT_TEST_API },
    machinePollInterval: "1 millis",
  }).pipe(
    Layer.provide(machine.layer),
    Layer.provide(mintingProvider().layer),
    Layer.provide(stubAttemptRuntime(storage, parent)),
    Layer.provide(claudeLoginLockLayer),
    Layer.provide(providers.layer),
  );

/** Records the host key that an earlier process pinned for a Hetzner machine. */
export const pinnedEarlier = (machine: ReturnType<typeof fakeMachine>, id: number) =>
  machine.state.localFiles.set(
    `${LOCAL_TEMPORARY_DIRECTORY}/hetzner-${String(id)}`,
    `usine-hetzner-${String(id)} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEarlierHostKeyForTests\n`,
  );

/** Returns the executor for `address` behind `gateway`. */
export const gatewayRuntimeOf = (
  machine: ReturnType<typeof fakeMachine>,
  providers: ReturnType<typeof fakeProviders>,
  gateway: ReturnType<typeof fakeGateway>,
  address: SshWorkerAddress,
  parent: StubParent = completes,
) =>
  Layer.merge(
    sshLayer({
      workers: [address],
      instance: INSTANCE,
      instanceId: INSTANCE_ID,
      interruptGrace: "2 seconds",
      providerEndpoints: { hetzner: HETZNER_TEST_API },
      machinePollInterval: "1 millis",
      machineReadyTimeout: "1 second",
    }).pipe(
      Layer.provide(machine.layer),
      Layer.provide(mintingProvider().layer),
      Layer.provide(stubAttemptRuntime(new StubStorage(), parent)),
      Layer.provide(claudeLoginLockLayer),
      Layer.provide(providers.over(gateway.layer)),
    ),
    Layer.effect(Attachments, Attachments).pipe(Layer.provide(gateway.layer)),
  );

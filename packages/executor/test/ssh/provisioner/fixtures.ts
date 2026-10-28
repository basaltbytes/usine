import { RunId } from "@usine/core/run";
import { SshIdentityFile, WorkerRoot } from "@usine/core/worker";
import {
  completes,
  type StubParent,
  StubStorage,
  stubAttemptRuntime,
} from "@usine/durable/testing";

import { Effect, Layer, Option, Redacted } from "effect";
import { claudeLoginLockLayer } from "../../../src/executor.ts";
import type { SshWorkerAddress } from "../../../src/ssh/model.ts";

import { layer as sshLayer } from "../../../src/ssh/ssh.ts";
import {
  ADDRESS,
  aloneOnItem,
  fakeMachine,
  INSTANCE,
  INSTANCE_ID,
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
      apiKeys: { anthropic: Option.some(Redacted.make(KEY)), openai: Option.none() },
    }),
  },
};

export const boatAddress: SshWorkerAddress = {
  ...ADDRESS,
  port: Option.none(),
  root: WorkerRoot.make("/home/user/.usine"),
  identityFile: Option.some(SshIdentityFile.make("/keys/usine_boat")),
  machine: { _tag: "Provisioned", provisioner: boatSettings() },
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
  options: { readonly parent?: StubParent; readonly storage?: StubStorage } = {},
) =>
  sshLayer({
    workers: [address],
    instance: INSTANCE,
    instanceId: INSTANCE_ID,
    interruptGrace: "2 seconds",
    providerEndpoints: { hetzner: HETZNER_TEST_API, boat: BOAT_TEST_API },
    machinePollInterval: "1 millis",
    machineReadyTimeout: "1 second",
  }).pipe(
    Layer.provide(machine.layer),
    Layer.provide(mintingProvider().layer),
    Layer.provide(
      stubAttemptRuntime(options.storage ?? new StubStorage(), options.parent ?? completes),
    ),
    Layer.provide(claudeLoginLockLayer),
    Layer.provide(providers.layer),
  );

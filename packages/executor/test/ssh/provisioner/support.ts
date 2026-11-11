import {
  BoxdRegion,
  BoxdSnapshotName,
  HetznerImage,
  HetznerLocation,
  HetznerResourceName,
  HetznerServerType,
  ProvisionerTimings,
  SshUser,
} from "@usine/core/worker";
import { Option, Redacted } from "effect";
import type {
  BoatProvisioner,
  BoxdProvisioner,
  HetznerProvisioner,
} from "../../../src/ssh/model.ts";

/** Returns the settings of a Hetzner provisioner that the fake Hetzner API accepts. */
export const hetznerSettings = (
  overrides: Partial<HetznerProvisioner> = {},
): HetznerProvisioner => ({
  provider: "hetzner",
  token: Redacted.make("hcloud-token-for-tests"),
  serverType: HetznerServerType.make("cx33"),
  location: HetznerLocation.make("nbg1"),
  image: HetznerImage.make("usine-worker-claude-2.1.308-codex-0.159.2"),
  network: Option.some(HetznerResourceName.make("usine-gateway")),
  firewall: Option.none(),
  sshKey: HetznerResourceName.make("usine-orchestrator"),
  sshUser: SshUser.make("usine"),
  labels: { team: "platform" },
  apiKeys: { anthropic: Option.none(), openai: Option.none() },
  timings: ProvisionerTimings.make({}),
  reuse: Option.none(),
  ...overrides,
});

/** Returns the settings of a Boat provisioner that the fake Boat API accepts. */
export const boatSettings = (overrides: Partial<BoatProvisioner> = {}): BoatProvisioner => ({
  provider: "boat",
  token: Redacted.make("boat_key_for_tests"),
  size: "default",
  snapshot: Option.none(),
  tailnet: Option.none(),
  apiKeys: { anthropic: Option.some(Redacted.make("sk-ant-api-for-tests")), openai: Option.none() },
  timings: ProvisionerTimings.make({}),
  reuse: Option.none(),
  ...overrides,
});

export const boxdSettings = (overrides: Partial<BoxdProvisioner> = {}): BoxdProvisioner => ({
  ...boatSettings(),
  provider: "boxd",
  token: Redacted.make("bxd_test_key"),
  endpoint: Option.none(),
  region: Option.some(BoxdRegion.make("fra")),
  size: "2x8",
  snapshot: BoxdSnapshotName.make("usine-attempt"),
  isolated: true,
  egress: Option.none(),
  ...overrides,
});

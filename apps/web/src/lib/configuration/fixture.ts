import { ConfigurationView } from "@usine/orchestrator/operator";
import { Schema } from "effect";

const label = (
  name: string,
  overrides: Partial<{
    readonly onGitHub: boolean | null;
    readonly color: string | null;
    readonly declared: boolean;
    readonly failure: string | null;
  }> = {},
) => ({
  name,
  onGitHub: overrides.onGitHub === undefined ? true : overrides.onGitHub,
  color: overrides.color === undefined ? "0e8a16" : overrides.color,
  description: null,
  declared: overrides.declared ?? true,
  failure:
    overrides.failure === undefined || overrides.failure === null
      ? null
      : {
          repository: "basaltbytes/usine",
          label: name,
          errorTag: "GitHubApiError",
          message: overrides.failure,
        },
});

const fileError = (file: string, stage: string, message: string) => ({
  _tag: "ConfigFileError",
  file,
  stage,
  message,
});

const startDevPrompt = `Implement issue #{{ item.number }}, **{{ item.title }}**, in {{ repo.name }}.

1. Read the issue and its comments.
2. Make the change with tests, then run \`pnpm test\`.
3. Open a pull request that closes #{{ item.number }}.
`;

/** Returns the ISO instant `minutes` before the fixture loads, or after it for a negative count. */
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const deferredHarness = (harness: string, checkedAt: string) => ({
  harness,
  check: {
    _tag: "Deferred",
    checkedAt,
    message: "Checked on the first machine, then every 86400 seconds when a machine is created.",
  },
});

/** A worker without a provisioner, as every kind but a provisioned SSH Worker has. */
const unprovisioned = { provisioner: null, machines: [], provisioning: null };

/**
 * The configuration view JSON, with loaded and quarantined Loops, a roster with an invalid Agent, a
 * local Worker, two SSH Workers with a destination, a Hetzner Worker with machines in flight and a
 * failed creation, a Boat Worker, and two repositories. Machine times are relative to the load.
 */
export const configurationJson = {
  loops: [
    {
      name: "start-dev",
      file: "loops/start-dev.md",
      stream: "issue",
      condition:
        'item.labels.nodes.exists(label, label.name == "ready") && item.assignees.totalCount == 0',
      cron: null,
      timeZone: null,
      selector: null,
      repositories: ["basaltbytes/usine", "basaltbytes/site"],
      approval: "required",
      maxCycles: 3,
      permissions: "write",
      priority: null,
      step: "implement",
      agent: "developer",
      prompt: startDevPrompt,
      paused: false,
      undeclaredLabels: ["urgent"],
    },
    {
      name: "review-pr",
      file: "loops/review-pr.md",
      stream: "pr",
      condition: "true",
      cron: null,
      timeZone: null,
      selector: { repos: null, tags: ["engine"] },
      repositories: ["basaltbytes/usine"],
      approval: "none",
      maxCycles: 2,
      permissions: "read",
      priority: 2,
      step: "review",
      agent: "reviewer",
      prompt: "Review the pull request.",
      paused: true,
      undeclaredLabels: [],
    },
  ],
  quarantinedLoops: [
    {
      name: "ghost",
      file: "loops/ghost.md",
      error: fileError(
        "loops/ghost.md",
        "reference",
        'Unknown agent "ghost": agents/ghost.md is missing or invalid. Fix the agent file, or set agent to an existing agent.',
      ),
    },
  ],
  agents: [
    {
      name: "developer",
      file: "agents/developer.md",
      harness: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      parentModel: null,
      parentEffort: "medium",
      resolvedParentModel: "openai-codex/gpt-5.6-terra",
      resolvedParentEffort: "medium",
      persona: "You implement issues.\n\n- Keep changes small.\n- Run the tests.",
      loops: ["start-dev"],
    },
    {
      name: "reviewer",
      file: "agents/reviewer.md",
      harness: "claude",
      model: "claude-opus-4-1",
      effort: "xhigh",
      parentModel: null,
      parentEffort: null,
      resolvedParentModel: "openai-codex/gpt-5.6-terra",
      resolvedParentEffort: "xhigh",
      persona: "You review pull requests.",
      loops: ["review-pr"],
    },
  ],
  invalidAgents: [
    {
      name: "broken",
      file: "agents/broken.md",
      error: fileError(
        "agents/broken.md",
        "yaml",
        "Flow sequence in block collection must be sufficiently indented",
      ),
    },
  ],
  workers: [
    {
      name: "local",
      kind: "local",
      maxConcurrentAttempts: 2,
      destination: null,
      port: null,
      identityFile: null,
      root: null,
      gateway: null,
      container: null,
      containerLimits: null,
      ...unprovisioned,
      slots: { capacity: 2, leased: 1 },
      prerequisites: { _tag: "Passed", checkedAt: "2026-10-20T08:00:00.000Z" },
      harnesses: [
        {
          harness: "claude",
          check: {
            _tag: "Failed",
            checkedAt: "2026-10-20T09:15:00.000Z",
            capability: "harness-login",
            message: "Claude Code needs a subscription login. Run claude auth login on the worker.",
          },
        },
        { harness: "codex", check: { _tag: "Passed", checkedAt: "2026-10-20T09:15:00.000Z" } },
      ],
    },
    {
      name: "eu-1",
      kind: "ssh",
      maxConcurrentAttempts: 3,
      destination: "usine@eu-1",
      port: null,
      identityFile: "~/.ssh/usine_worker",
      root: "/srv/usine",
      gateway: {
        domain: "gw.internal",
        destination: "usine-gateway",
        adminPort: 7070,
        adminTokenEnv: "USINE_GATEWAY_ADMIN_TOKEN",
        llmProviders: ["anthropic"],
      },
      container: { image: null, cpus: null, memoryMib: 3584, pids: null },
      containerLimits: null,
      ...unprovisioned,
      slots: { capacity: 3, leased: 0 },
      prerequisites: null,
      harnesses: [],
    },
    {
      name: "eu-2",
      kind: "ssh",
      maxConcurrentAttempts: 1,
      destination: "usine@eu-2",
      port: null,
      identityFile: null,
      root: "/srv/usine",
      gateway: null,
      container: {
        image: "registry.example/usine-worker:custom",
        cpus: 1.5,
        memoryMib: 6144,
        pids: 2048,
      },
      containerLimits: null,
      ...unprovisioned,
      slots: { capacity: 1, leased: 0 },
      prerequisites: {
        _tag: "Degraded",
        checkedAt: "2026-10-20T08:00:00.000Z",
        message:
          "Docker isn't installed, so attempts run as the SSH user and can read each other's credentials. Install Docker to run each attempt in its own container.",
      },
      harnesses: [
        { harness: "claude", check: { _tag: "Passed", checkedAt: "2026-10-20T08:00:00.000Z" } },
      ],
    },
    {
      name: "hz-pool",
      kind: "ssh",
      maxConcurrentAttempts: 3,
      destination: null,
      port: null,
      identityFile: "~/.ssh/usine_hetzner",
      root: "/srv/usine",
      gateway: {
        domain: "gw.internal",
        destination: "usine-gateway",
        adminPort: 7070,
        adminTokenEnv: "USINE_GATEWAY_ADMIN_TOKEN",
        llmProviders: ["anthropic"],
      },
      container: { image: null, cpus: null, memoryMib: null, pids: null },
      containerLimits: null,
      provisioner: {
        _tag: "hetzner",
        tokenEnv: "HCLOUD_TOKEN",
        serverType: "cx33",
        location: "nbg1",
        image: "usine-worker-2026-10-24",
        network: "usine-private",
        firewall: null,
        sshKey: "usine-orchestrator",
        sshUser: "usine",
        labels: { team: "platform" },
        anthropicKeyEnv: null,
        openaiKeyEnv: null,
      },
      machines: [
        {
          worker: "hz-pool",
          provider: "hetzner",
          state: "deleting",
          id: "52341001",
          runId: null,
          attemptId: "7c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5",
          since: minutesAgo(95),
        },
        {
          worker: "hz-pool",
          provider: "hetzner",
          state: "ready",
          id: "52341896",
          runId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
          attemptId: "3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7",
          since: minutesAgo(12),
        },
        {
          worker: "hz-pool",
          provider: "hetzner",
          state: "creating",
          id: null,
          runId: "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a",
          attemptId: null,
          since: minutesAgo(1),
        },
      ],
      provisioning: {
        reason: "quota",
        message: "Hetzner Cloud refused the server: server limit reached (resource_limit_exceeded)",
        failures: 3,
        failedAt: minutesAgo(2),
        retryAt: minutesAgo(-6),
        blocked: true,
      },
      slots: { capacity: 3, leased: 2 },
      prerequisites: { _tag: "Passed", checkedAt: "2026-10-20T08:00:00.000Z" },
      harnesses: [deferredHarness("claude", "2026-10-20T08:00:00.000Z")],
    },
    {
      name: "boat-pool",
      kind: "ssh",
      maxConcurrentAttempts: 2,
      destination: null,
      port: null,
      identityFile: "~/.ssh/usine_boat",
      root: "/home/usine",
      gateway: null,
      container: null,
      containerLimits: null,
      provisioner: {
        _tag: "boat",
        tokenEnv: "BOAT_API_KEY",
        size: "default",
        anthropicKeyEnv: "ANTHROPIC_API_KEY",
        openaiKeyEnv: null,
      },
      machines: [],
      provisioning: null,
      slots: { capacity: 2, leased: 0 },
      prerequisites: { _tag: "Passed", checkedAt: "2026-10-20T08:00:00.000Z" },
      harnesses: [deferredHarness("claude", "2026-10-20T09:30:00.000Z")],
    },
  ],
  removedWorkers: [{ name: "spare", running: 1 }],
  repositories: [
    {
      name: "basaltbytes/usine",
      tags: ["engine"],
      lanes: [
        { name: "Ready", sources: [{ _tag: "Label", label: label("ready") }] },
        {
          name: "In review",
          sources: [
            {
              _tag: "Label",
              label: label("ready-for-review", {
                onGitHub: false,
                color: null,
                failure: "GitHub rejected the request with status 403",
              }),
            },
            { _tag: "State", state: "pr-open" },
          ],
        },
      ],
      declaredLabels: [label("ready")],
      loops: ["start-dev", "review-pr"],
    },
    {
      name: "basaltbytes/site",
      tags: [],
      lanes: [],
      declaredLabels: [label("ready", { onGitHub: null })],
      loops: ["start-dev"],
    },
  ],
  settings: {
    pollInterval: 60,
    maxChildren: 4,
    maxAttemptMinutes: null,
    maxAttemptTokens: 20_000_000,
    parentModel: "openai-codex/gpt-5.6-terra",
    parentEffort: null,
    operator: "PhilDL",
    webhooks: "off",
    webhooksPublicUrl: null,
    tracing: { otlpUrl: "http://localhost:4318/v1/traces", serviceName: "usine-eu" },
  },
};

export const configurationFixture = (): ConfigurationView =>
  Schema.decodeUnknownSync(ConfigurationView)(configurationJson);

/** Returns the fixture with every list empty, as for a new instance folder. */
export const emptyConfiguration = (): ConfigurationView =>
  Schema.decodeUnknownSync(ConfigurationView)({
    ...configurationJson,
    loops: [],
    quarantinedLoops: [],
    agents: [],
    invalidAgents: [],
    removedWorkers: [],
    repositories: [],
  });

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

/** The configuration view JSON, with loaded and quarantined Loops, a roster with an invalid Agent, a
 * local and an SSH Worker, and two repositories. */
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
      slots: { capacity: 3, leased: 0 },
      prerequisites: null,
      harnesses: [],
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

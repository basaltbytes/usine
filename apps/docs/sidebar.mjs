// @ts-check

/** @satisfies {import("@astrojs/starlight/types").StarlightUserConfig["sidebar"]} */
export const guideGroups = [
  {
    label: "Run usine",
    collapsed: true,
    items: [
      { label: "Overview", slug: "guides/run-usine" },
      { slug: "guides/run-usine-locally" },
      { slug: "guides/host-usine-on-linux" },
      { slug: "guides/keep-the-orchestrator-running" },
      { slug: "guides/expose-an-instance" },
      { slug: "guides/open-the-web-ui" },
      { slug: "guides/upgrade-an-instance" },
      { slug: "guides/back-up-instance-state" },
      { slug: "guides/restore-instance-state" },
      { slug: "guides/move-an-instance" },
      { slug: "guides/run-the-orchestrator-on-a-server" },
    ],
  },
  {
    label: "Workers",
    collapsed: true,
    items: [
      { label: "Overview", slug: "guides/workers" },
      { slug: "guides/add-a-worker" },
      { slug: "guides/add-an-ssh-worker" },
      { slug: "guides/add-a-boat-worker" },
      { slug: "guides/add-a-provisioned-worker" },
      { slug: "guides/cloudflare-sandboxes" },
      { slug: "guides/configure-a-gateway" },
      { slug: "guides/connect-boat-to-a-gateway" },
      { slug: "guides/run-worker-preflight" },
      { slug: "guides/remove-a-worker" },
    ],
  },
  {
    label: "Loops and agents",
    collapsed: true,
    items: [
      { label: "Overview", slug: "guides/loops-and-agents" },
      { slug: "guides/write-a-loop" },
      { slug: "guides/write-a-schedule-loop" },
      { slug: "guides/write-an-agent" },
      { slug: "guides/review-fix-loops" },
      { slug: "guides/change-the-configuration" },
      { slug: "guides/revert-configuration" },
      { slug: "guides/pause-a-loop" },
    ],
  },
  {
    label: "Work with runs",
    collapsed: true,
    items: [
      { label: "Overview", slug: "guides/work-with-runs" },
      { slug: "guides/approve-a-run" },
      { slug: "guides/follow-a-run" },
      { slug: "guides/message-an-agent" },
      { slug: "guides/answer-an-agent" },
      { slug: "guides/cancel-a-run" },
      { slug: "guides/retry-a-run" },
      { slug: "guides/run-again" },
      { slug: "guides/export-a-run" },
      { slug: "guides/move-a-task" },
      { slug: "guides/read-statistics" },
    ],
  },
  {
    label: "Access",
    collapsed: true,
    items: [
      { label: "Overview", slug: "guides/access" },
      { slug: "guides/sign-in" },
      { slug: "guides/manage-members" },
      { slug: "guides/create-a-device-token" },
    ],
  },
];

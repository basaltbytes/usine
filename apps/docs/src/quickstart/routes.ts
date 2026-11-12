import developer from "../../quickstart/agents/developer.md?raw";

/** A harness the quickstart's developer agent can run on, with an example model for it. */
export interface QuickstartRoute {
  /** The tab label and the harness name in prose. */
  readonly label: string;
  /** The agent's `harness` value. */
  readonly harness: "claude" | "codex" | "pi";
  /** The agent's `model` value; Pi models use `provider/model`. */
  readonly model: string;
}

/** One route per maintained harness, in the order the quickstart tabs show them. */
export const quickstartRoutes: ReadonlyArray<QuickstartRoute> = [
  { label: "Pi", harness: "pi", model: "openrouter/openai/gpt-6-astra" },
  { label: "Claude Code", harness: "claude", model: "sonnet" },
  { label: "Codex", harness: "codex", model: "gpt-6-astra" },
];

/** Returns the bootstrap `agents/developer.md` with the harness and model of `route`. */
export const developerAgent = (route: QuickstartRoute): string =>
  developer
    .replace(/^harness: .*$/mu, `harness: ${route.harness}`)
    .replace(/^model: .*$/mu, `model: ${route.model}`);

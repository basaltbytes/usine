import developer from "../../quickstart/agents/developer.md?raw";
import loop from "../../quickstart/projects/scratch/loops/first-pr.md?raw";
import settings from "../../quickstart/usine.yaml?raw";
import type { QuickstartRoute } from "./routes.ts";

/** Returns the bootstrap `agents/developer.md` with the harness and model of `route`. */
export const developerAgent = (route: QuickstartRoute): string =>
  developer
    .replace(/^harness: .*$/mu, `harness: ${route.harness}`)
    .replace(/^model: .*$/mu, `model: ${route.model}`);

/**
 * Returns the shell command that writes the bootstrap files for `route` to
 * `~/usine-instance`. The command reads the GitHub login from `$GITHUB_LOGIN`.
 */
export const bootstrapCommand = (route: QuickstartRoute): string =>
  [
    "mkdir -p ~/usine-instance/agents ~/usine-instance/projects/scratch/loops",
    "cd ~/usine-instance",
    "printf '.usine/\\n.env\\n' > .gitignore",
    "cat > usine.yaml <<YAML",
    settings.replaceAll("YOUR_GITHUB_LOGIN", "$GITHUB_LOGIN").trimEnd(),
    "YAML",
    "cat > agents/developer.md <<'AGENT'",
    developerAgent(route).trimEnd(),
    "AGENT",
    "cat > projects/scratch/loops/first-pr.md <<'LOOP'",
    loop.trimEnd(),
    "LOOP",
    "ls agents projects/scratch/loops",
  ].join("\n");

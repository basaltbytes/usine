import { assert, it } from "@effect/vitest";
import { GitHubLabelName } from "@usine/config/label";
import { RepositoryName } from "@usine/core/repository";
import { LabelPreflightFinding } from "../src/label-reconciler.ts";
import { PreflightFindingNeed } from "../src/operator/need.ts";
import { attentionKey, partitionNeeds } from "../src/operator/attention.ts";

it("shows a changed preflight finding again and ignores acknowledgements of a different entry", () => {
  const original = new PreflightFindingNeed({
    id: "preflight-finding",
    finding: new LabelPreflightFinding({
      repository: RepositoryName.make("test/project"),
      label: GitHubLabelName.make("ready"),
      errorTag: "GitHubApiError",
      message: "Could not create label",
    }),
  });
  const acknowledged = [attentionKey(original)];
  assert.deepStrictEqual(partitionNeeds([original], acknowledged), {
    needsYou: [],
    dismissedNeeds: [original],
  });
  for (const finding of [
    new LabelPreflightFinding({ ...original.finding, label: GitHubLabelName.make("review") }),
    new LabelPreflightFinding({ ...original.finding, message: "Label permission denied" }),
  ]) {
    const changed = new PreflightFindingNeed({ ...original, finding });
    assert.deepStrictEqual(partitionNeeds([changed], acknowledged), {
      needsYou: [changed],
      dismissedNeeds: [],
    });
  }
  const other = new PreflightFindingNeed({ ...original, id: "another-finding" });
  assert.deepStrictEqual(partitionNeeds([other], acknowledged).needsYou, [other]);
  assert.deepStrictEqual(partitionNeeds([original], []).needsYou, [original]);
});

import { AgentFailureView } from "@usine/orchestrator/operator";
import { Option } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { assert, describe, it } from "vitest";
import { Outcome } from "~/components/runs/transcript/outcome";

const failure = AgentFailureView.make({ message: "The run added no outcome label." });

const markup = (report: Option.Option<string>) =>
  renderToStaticMarkup(
    <Outcome end={{ _tag: "Failed", failure, report, salvage: null }} outOfMemory={null} />,
  );

describe("failed outcome", () => {
  it("shows the rejected final report after the failure, labeled", () => {
    const html = markup(Option.some("Review published on **PR #320**."));
    assert.isBelow(html.indexOf(failure.message), html.indexOf("Final report"));
    const section = /<section aria-labelledby="([^"]+)"[^>]*>(.*)<\/section>/su.exec(html);
    assert.isNotNull(section);
    const [, labelId = "", body = ""] = section;
    assert.include(
      body,
      `<p id="${labelId}" class="text-xs text-muted-foreground">Final report</p>`,
    );
    assert.include(body, "<strong>PR #320</strong>");
  });

  it("shows no report section for a failure without one", () => {
    const html = markup(Option.none());
    assert.include(html, failure.message);
    assert.notInclude(html, "Final report");
    assert.notInclude(html, "<section");
  });
});

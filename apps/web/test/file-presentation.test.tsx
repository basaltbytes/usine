import { Schema } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { assert, describe, it } from "vitest";
import { presentFile } from "../src/run-transcript/tool/files.ts";
import { ToolSections } from "../src/run-transcript/tool/content.tsx";

describe("file presentation", () => {
  it("shows Pi's recorded patch before its confirmation and metadata", () => {
    const input = Schema.Json.make({
      path: "src/count.ts",
      edits: [{ oldText: "const before = 1;", newText: "const after = 2;" }],
    });
    const output = Schema.Json.make({
      content: [{ type: "text", text: "Successfully replaced 1 block in src/count.ts." }],
      details: {
        patch:
          "--- src/count.ts\n+++ src/count.ts\n@@ -1 +1 @@\n-const before = 1;\n+const after = 2;\n",
        diff: "-1 const before = 1;\n+1 const after = 2;",
        firstChangedLine: 1,
      },
    });
    const view = presentFile(input, output, "edit");
    const markup = renderToStaticMarkup(<ToolSections sections={view.output} category="edit" />);

    assert.include(markup, "src/count.ts");
    assert.include(markup, "-const before = 1;");
    assert.include(markup, "+const after = 2;");
    assert.include(markup, "Successfully replaced 1 block in src/count.ts.");
    assert.include(markup, "First changed line");
    assert.isBelow(markup.indexOf("+const after = 2;"), markup.indexOf("Successfully replaced"));
    assert.isBelow(markup.indexOf("Successfully replaced"), markup.indexOf("First changed line"));
    assert.strictEqual(markup.split("const before = 1;").length - 1, 1);
  });

  it("keeps Claude's replacement text before its confirmation when no patch was returned", () => {
    const view = presentFile(
      Schema.Json.make({
        file_path: "/repo/src/count.ts",
        old_string: "const before = 1;",
        new_string: "const after = 2;",
        replace_all: false,
      }),
      Schema.Json.make([{ type: "text", text: "The file has been updated successfully." }]),
      "edit",
    );
    const markup = renderToStaticMarkup(
      <>
        <ToolSections sections={view.input} category="edit" />
        <ToolSections sections={view.output} category="edit" />
      </>,
    );

    assert.include(markup, "Before");
    assert.include(markup, "After");
    assert.include(markup, "const before = 1;");
    assert.include(markup, "const after = 2;");
    assert.include(markup, "The file has been updated successfully.");
    assert.isBelow(markup.indexOf("const before = 1;"), markup.indexOf("const after = 2;"));
    assert.isBelow(markup.indexOf("const after = 2;"), markup.indexOf("The file has been updated"));
  });
});

import { Schema } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { assert, describe, it } from "vitest";
import { presentFile } from "~/lib/runs/transcript/tool/files";
import { ToolSections } from "~/components/runs/transcript/tool/content";

describe("file presentation", () => {
  it("summarizes a read request without claiming its limit was the number of lines returned", () => {
    const input = Schema.Json.make({ path: "src/count.ts", offset: 48, limit: 8 });
    const source = "const count = 1;\n\n[12 more lines in file. Use offset=49 to continue.]";
    const output = Schema.Json.make({ content: [{ type: "text", text: source }] });
    const view = presentFile(input, output, "read");

    assert.equal(view.subject, "src/count.ts · From line 48 · up to 8 lines");
    assert.isEmpty(view.input);
    const text = view.output.find((section) => section._tag === "Code");
    assert.isDefined(text);
    assert.equal(text.text, source);
    assert.deepEqual(input, { path: "src/count.ts", offset: 48, limit: 8 });
    assert.deepEqual(output, { content: [{ type: "text", text: source }] });
  });

  it("does not invent a starting line when the recorded offset is invalid", () => {
    const view = presentFile({ path: "src/count.ts", offset: -1, limit: 8 }, "Result", "read");
    assert.equal(view.subject, "src/count.ts · up to 8 lines");
    const options = view.input.find((section) => section._tag === "Fields");
    assert.isDefined(options);
    assert.deepInclude(options.fields, { label: "Offset", value: -1 });
  });

  it("preserves Claude's recorded source numbers without adding relative line numbers", () => {
    const source = "48:const before = 1;\n49:const after = 2;";
    const view = presentFile(
      Schema.Json.make({ file_path: "src/count.ts", offset: 48, limit: 8 }),
      Schema.Json.make([{ type: "text", text: source }]),
      "read",
    );
    const markup = renderToStaticMarkup(<ToolSections sections={view.output} category="read" />);
    const visibleText = markup.replace(/<[^>]*>/gu, "");

    assert.equal(view.subject, "src/count.ts · From line 48 · up to 8 lines");
    assert.equal(visibleText, `src/count.ts${source}`);
  });

  it.each([undefined, null, { error: "Access denied" }])(
    "keeps the request cue available when a read has no source output: %s",
    (output) => {
      const view = presentFile(
        Schema.Json.make({ file_path: "src/count.ts", offset: 48, limit: 8 }),
        output,
        "read",
      );
      assert.equal(view.subject, "src/count.ts · From line 48 · up to 8 lines");
      assert.isEmpty(view.input);
    },
  );

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

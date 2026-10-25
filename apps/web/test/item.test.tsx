import { Option } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { assert, describe, it } from "vitest";
import { ItemHeading } from "../src/components/item/heading.tsx";
import { pullRequestAt, type TitledItem, taskIdentity } from "../src/components/item/identity.ts";
import { ItemMark, type ItemRef, itemLabel, itemName } from "../src/components/item/mark.tsx";

const ref = (kind: ItemRef["kind"], number: number, state: ItemRef["state"]): ItemRef => ({
  kind,
  number,
  url: `https://github.com/basaltbytes/usine/${kind === "pr" ? "pull" : "issues"}/${number}`,
  state,
});
const titled = (
  kind: ItemRef["kind"],
  number: number,
  state: ItemRef["state"],
  title = `Item ${number}`,
): TitledItem => ({ ...ref(kind, number, state), title });

describe("item mark", () => {
  const cases = [
    ["issue", "issue-open", "octicon-issue-opened", "text-run-succeeded", "Issue #1, open"],
    ["issue", "issue-closed", "octicon-issue-closed", "text-primary", "Issue #1, closed"],
    ["issue", null, "octicon-issue-opened", "text-muted-foreground", "Issue #1"],
    ["pr", "pr-open", "octicon-git-pull-request", "text-run-succeeded", "Pull request #1, open"],
    ["pr", "pr-merged", "octicon-git-merge", "text-primary", "Pull request #1, merged"],
    [
      "pr",
      "pr-closed",
      "octicon-git-pull-request-closed",
      "text-run-failed",
      "Pull request #1, closed",
    ],
    ["pr", null, "octicon-git-pull-request", "text-muted-foreground", "Pull request #1"],
  ] as const;

  it("shows each kind and state with GitHub's icon and colour, and says both in words", () => {
    for (const [kind, state, icon, tone, label] of cases) {
      const markup = renderToStaticMarkup(<ItemMark item={ref(kind, 1, state)} />);
      assert.include(markup, `class="octicon ${icon} `, label);
      assert.match(markup, new RegExp(`^<a [^>]*class="[^"]*\\b${tone}\\b`, "u"), label);
      assert.include(markup, `aria-label="${label}"`, label);
      assert.include(markup, `title="${label}"`, label);
      assert.strictEqual(markup.replaceAll(/<[^>]+>/gu, ""), "#1", label);
      assert.strictEqual(itemLabel(ref(kind, 1, state)), label);
    }
  });

  it("links to GitHub in a new tab unless it sits inside another control", () => {
    const linked = renderToStaticMarkup(<ItemMark item={ref("issue", 481, "issue-closed")} />);
    assert.include(linked, 'href="https://github.com/basaltbytes/usine/issues/481"');
    assert.include(linked, 'target="_blank"');
    const plain = renderToStaticMarkup(
      <ItemMark item={ref("issue", 481, "issue-closed")} linked={false} />,
    );
    assert.notInclude(plain, "<a ");
    assert.match(
      plain,
      /^<span role="img" title="Issue #481, closed" aria-label="Issue #481, closed"/u,
    );
  });

  it("can show the icon alone, still named in words", () => {
    const markup = renderToStaticMarkup(
      <ItemMark item={ref("pr", 6, "pr-merged")} linked={false} numbered={false} />,
    );
    assert.include(markup, 'aria-label="Pull request #6, merged"');
    assert.notInclude(markup, "#6<");
  });

  it("names the item for a sentence", () => {
    assert.strictEqual(itemName(ref("pr", 530, "pr-closed")), "pull request #530");
    assert.strictEqual(itemName(ref("issue", 481, null)), "issue #481");
  });
});

describe("item heading", () => {
  it("puts the mark inline before the title, followed by a space", () => {
    const markup = renderToStaticMarkup(
      <ItemHeading
        variant="page"
        item={Option.some(ref("issue", 481, "issue-closed"))}
        title="Dependency follow-ups"
      />,
    );
    assert.match(markup, /^<h1 [^>]*><a [^>]*>.*<\/a> Dependency follow-ups<\/h1>$/su);
  });

  it("keeps a row to one line with the title as tooltip", () => {
    const markup = renderToStaticMarkup(
      <ItemHeading
        variant="row"
        item={Option.some(ref("pr", 530, "pr-closed"))}
        title="Bump the npm group"
        linked={false}
      />,
    );
    assert.match(markup, /^<span class="[^"]*\btruncate\b[^"]*" title="Bump the npm group">/u);
    assert.notInclude(markup, "<a ");
  });

  it("renders only the title without an item", () => {
    assert.strictEqual(
      renderToStaticMarkup(<ItemHeading variant="page" item={Option.none()} title="Nightly" />),
      '<h1 class="text-xl font-semibold wrap-anywhere">Nightly</h1>',
    );
  });
});

describe("task identity", () => {
  it("names a Task after its earliest issue and lists its other pull requests by number", () => {
    const identity = taskIdentity([
      titled("pr", 482, "pr-merged"),
      titled("issue", 490, "issue-open"),
      titled("pr", 470, "pr-closed"),
      titled("issue", 481, "issue-closed", "Dependency follow-ups"),
    ]);
    assert.strictEqual(identity.origin.number, 481);
    assert.strictEqual(identity.origin.title, "Dependency follow-ups");
    assert.deepStrictEqual(
      identity.pullRequests.map(({ number }) => number),
      [470, 482],
    );
  });

  it("names a Task with no issue after its earliest pull request", () => {
    const identity = taskIdentity([titled("pr", 531, "pr-open"), titled("pr", 530, "pr-closed")]);
    assert.strictEqual(identity.origin.number, 530);
    assert.deepStrictEqual(
      identity.pullRequests.map(({ number }) => number),
      [531],
    );
  });

  it("finds a Run's pull request among the Task's items, else marks its state unknown", () => {
    const members = [titled("issue", 481, "issue-closed"), titled("pr", 482, "pr-merged")];
    assert.deepStrictEqual(
      Option.map(
        pullRequestAt("https://github.com/basaltbytes/usine/pull/482", members),
        ({ number, state }) => `${number} ${state}`,
      ),
      Option.some("482 pr-merged"),
    );
    assert.deepStrictEqual(
      pullRequestAt("https://github.com/basaltbytes/usine/pull/9", members),
      Option.some(ref("pr", 9, null)),
    );
    assert.isTrue(Option.isNone(pullRequestAt("https://github.com/basaltbytes/usine", members)));
  });
});

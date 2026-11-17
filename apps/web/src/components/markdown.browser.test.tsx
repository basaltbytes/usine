import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import { Markdown } from "~/components/markdown";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  root.unmount();
  host.remove();
});

const render = (markdown: string) => flushSync(() => root.render(<Markdown>{markdown}</Markdown>));

it("renders images as links to their URL, and as text inside a link", () => {
  render(
    [
      "![chart](https://example.com/chart.png?d=secret)",
      "",
      "![](https://example.com/bare.png)",
      "",
      "[![badge](https://example.com/badge.svg)](https://example.com/build)",
      "",
      '<img src="https://example.com/raw.png">',
    ].join("\n"),
  );
  expect(host.querySelectorAll("img")).toHaveLength(0);
  expect(page.getByRole("link", { name: "chart" }).element().getAttribute("href")).toBe(
    "https://example.com/chart.png?d=secret",
  );
  expect(
    page.getByRole("link", { name: "https://example.com/bare.png" }).element().getAttribute("href"),
  ).toBe("https://example.com/bare.png");
  expect(page.getByRole("link", { name: "badge" }).element().getAttribute("href")).toBe(
    "https://example.com/build",
  );
  expect(host.querySelectorAll("a a")).toHaveLength(0);
});

it("links only http, https, and mailto URLs, in a new tab without opener or referrer", () => {
  render(
    [
      "[web](https://example.com/a)",
      "[mail](mailto:ops@example.com)",
      "[script](javascript:alert(1))",
      "[file](ftp://example.com/f)",
      "[relative](/projects/x)",
    ].join(" "),
  );
  const links = [...host.querySelectorAll("a")];
  expect(links.map((link) => link.textContent)).toEqual(["web", "mail"]);
  for (const link of links) {
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  }
  expect(host.textContent).toContain("script");
  expect(host.textContent).toContain("relative");
});

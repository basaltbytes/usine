import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { Markdown } from "~/components/markdown";
import { routeTree } from "~/route-tree.gen";

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

it("opens a path that a route matches in the app, and keeps an unknown or unsafe link as text", async () => {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/conversations"] }),
    context: { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
  });
  flushSync(() =>
    root.render(
      <RouterContextProvider router={router}>
        <Markdown>
          {[
            "[task](/projects/basaltbytes-usine/tasks/40?repository=basaltbytes/usine#runs)",
            "[unknown](/nowhere/at/all)",
            "[deep](/projects/basaltbytes-usine/tasks/40/more)",
            "[relative](tasks/40)",
            "[other host](//example.com/projects/x)",
            "[script](javascript:alert(1))",
            "[data](data:text/html,hi)",
            "[web](https://example.com/a)",
            "[home elsewhere](https://example.com/)",
            "[tasks elsewhere](https://other.example/projects/basaltbytes-usine/tasks)",
          ].join(" ")}
        </Markdown>
      </RouterContextProvider>,
    ),
  );
  expect([...host.querySelectorAll("a")].map((link) => link.textContent)).toEqual([
    "task",
    "web",
    "home elsewhere",
    "tasks elsewhere",
  ]);
  const task = page.getByRole("link", { name: "task", exact: true });
  await expect
    .element(task)
    .toHaveAttribute(
      "href",
      "/projects/basaltbytes-usine/tasks/40?repository=basaltbytes%2Fusine#runs",
    );
  expect(task.element().getAttribute("target")).toBeNull();
  // A URL on another origin stays external, even when its path is a page of the app.
  for (const [name, href] of [
    ["home elsewhere", "https://example.com/"],
    ["tasks elsewhere", "https://other.example/projects/basaltbytes-usine/tasks"],
  ] as const) {
    const external = page.getByRole("link", { name, exact: true }).element();
    expect([external.getAttribute("href"), external.getAttribute("target")]).toEqual([
      href,
      "_blank",
    ]);
  }
  const navigate = vi.spyOn(router, "navigate").mockResolvedValue();
  await task.click();
  expect(navigate).toHaveBeenCalledWith(
    expect.objectContaining({
      href: "/projects/basaltbytes-usine/tasks/40?repository=basaltbytes/usine#runs",
    }),
  );
});

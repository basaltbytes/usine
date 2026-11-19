import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import { useIsMobile } from "./use-mobile";

const Viewport = () => <output>{useIsMobile() ? "mobile" : "desktop"}</output>;

let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  await page.viewport(1280, 800);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root.render(<Viewport />));
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

it("updates on viewport changes without a parent render", async () => {
  const output = page.getByRole("status");
  await expect.element(output).toHaveTextContent("desktop");
  await page.viewport(390, 844);
  await expect.element(output).toHaveTextContent("mobile");
  await page.viewport(1280, 800);
  await expect.element(output).toHaveTextContent("desktop");
});

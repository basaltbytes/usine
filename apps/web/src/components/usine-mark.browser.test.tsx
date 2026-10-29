import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { commands } from "vitest/browser";
import { UsineMark } from "~/components/usine-mark";
import "~/index.css";

declare module "vitest/browser" {
  interface BrowserCommands {
    reducedMotion: (reduce: boolean) => Promise<void>;
  }
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  flushSync(() => root.unmount());
  host.remove();
  await commands.reducedMotion(false);
});

const tiles = () => [...host.querySelectorAll("rect")].map((rect) => getComputedStyle(rect));

it("lights each tile in flow order, one 130ms step apart in a 1.3s cycle, while running", () => {
  flushSync(() => root.render(<UsineMark running />));
  expect(
    tiles().map(({ animationName, animationDuration, animationDelay }) => [
      animationName,
      animationDuration,
      animationDelay,
    ]),
  ).toEqual(
    ["0s", "0.13s", "0.26s", "0.39s", "0.52s", "0.65s", "0.78s"].map((delay) => [
      "usine-mark-running",
      "1.3s",
      delay,
    ]),
  );
  flushSync(() => root.render(<UsineMark />));
  expect(tiles().map(({ animationName }) => animationName)).toEqual(Array(7).fill("none"));
});

it("shows the static mark, shaded along the flow, if the reader prefers reduced motion", async () => {
  await commands.reducedMotion(true);
  flushSync(() => root.render(<UsineMark running />));
  expect(tiles().map(({ animationName, fillOpacity }) => [animationName, fillOpacity])).toEqual(
    ["0.3", "0.4", "0.5", "0.62", "0.74", "0.87", "1"].map((opacity) => ["none", opacity]),
  );
});

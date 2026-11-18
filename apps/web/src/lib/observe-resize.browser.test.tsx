import { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { observeResize } from "~/lib/observe-resize";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

const Width = () => {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // oxlint-disable-next-line usine/no-unreasoned-effect -- Observe the test element to verify DOM measurements commit before paint.
  useLayoutEffect(() => {
    const box = ref.current;
    if (box === null) return;
    return observeResize([box], () => setWidth(box.offsetWidth));
  }, []);
  return <div ref={ref}>{width}</div>;
};

it("commits the state a resize sets before the browser paints", async () => {
  host.style.width = "100px";
  flushSync(() => root.render(<Width />));
  const box = host.querySelector("div");
  if (box === null) throw new Error("Missing measured box");
  await expect.poll(() => box.textContent).toBe("100");
  // Observers run in creation order within one frame, so this one sees the commit of the first.
  const seen: Array<string | null> = [];
  const stop = observeResize([box], () => seen.push(box.textContent));
  await expect.poll(() => seen.length).toBe(1);
  host.style.width = "160px";
  await expect.poll(() => seen.length).toBe(2);
  stop();
  expect(seen).toEqual(["100", "160"]);
});

import { flushSync } from "react-dom";

/**
 * Calls `onResize` when any of `elements` changes size, and returns a function that stops
 * observing. React commits state set in `onResize` before the browser paints.
 */
export const observeResize = (
  elements: ReadonlyArray<Element>,
  onResize: (entries: ReadonlyArray<ResizeObserverEntry>) => void,
): (() => void) => {
  const observer = new ResizeObserver((entries) => flushSync(() => onResize(entries)));
  for (const element of elements) observer.observe(element);
  return () => observer.disconnect();
};

import { type RefCallback, useRef, useState } from "react";
import { observeResize } from "~/lib/observe-resize";

/** Whether content is hidden above and below the visible part of a scroll container. */
export interface ScrollEdges {
  readonly above: boolean;
  readonly below: boolean;
}

const settled: ScrollEdges = { above: false, below: false };

/**
 * Returns a ref for a vertical scroll container and which of its edges hide content. The edges
 * update on scroll and when the container or its children change size.
 */
export const useScrollEdges = (): readonly [RefCallback<HTMLElement>, ScrollEdges] => {
  const [edges, setEdges] = useState<ScrollEdges>(settled);
  const cleanup = useRef<(() => void) | null>(null);
  const ref = (node: HTMLElement | null) => {
    cleanup.current?.();
    cleanup.current = null;
    if (node === null) return;
    const measure = () => {
      // One pixel of tolerance absorbs fractional scroll offsets on scaled displays.
      const above = node.scrollTop > 1;
      const below = node.scrollHeight - node.clientHeight - node.scrollTop > 1;
      setEdges((current) =>
        current.above === above && current.below === below ? current : { above, below },
      );
    };
    let stopResize = observeResize([node, ...node.children], measure);
    const mutation = new MutationObserver(() => {
      stopResize();
      stopResize = observeResize([node, ...node.children], measure);
      measure();
    });
    mutation.observe(node, { childList: true });
    node.addEventListener("scroll", measure, { passive: true });
    measure();
    cleanup.current = () => {
      node.removeEventListener("scroll", measure);
      mutation.disconnect();
      stopResize();
    };
  };
  return [ref, edges] as const;
};

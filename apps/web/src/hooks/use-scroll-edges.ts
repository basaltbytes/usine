import { type RefCallback, useCallback, useRef, useState } from "react";

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
  const ref = useCallback((node: HTMLElement | null) => {
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
    const resize = new ResizeObserver(measure);
    const observeChildren = () => {
      resize.observe(node);
      for (const child of node.children) resize.observe(child);
    };
    const mutation = new MutationObserver(() => {
      resize.disconnect();
      observeChildren();
      measure();
    });
    observeChildren();
    mutation.observe(node, { childList: true });
    node.addEventListener("scroll", measure, { passive: true });
    measure();
    cleanup.current = () => {
      node.removeEventListener("scroll", measure);
      mutation.disconnect();
      resize.disconnect();
    };
  }, []);
  return [ref, edges] as const;
};

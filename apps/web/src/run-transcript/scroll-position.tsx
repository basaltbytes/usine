import { Component, type ReactNode, type RefObject } from "react";

interface Props {
  readonly viewportRef: RefObject<HTMLDivElement | null>;
  /** A value that changes whenever transcript rows change size or content. */
  readonly revision: number;
  /** Whether the viewport is shown; while `false`, the last visible row is kept. */
  readonly active: boolean;
  readonly children: ReactNode;
}

interface ReadingPosition {
  readonly viewport: HTMLDivElement;
  readonly element: HTMLElement;
  readonly identity: string | null;
  readonly offset: number;
}

/** The minimum visible height, in pixels, of a preferred anchor row. */
export const VISIBLE_ROW_EDGE = 24;

const deepestRow = (
  viewport: HTMLDivElement,
  from: number,
  bottom: number,
): HTMLElement | undefined => {
  let element: HTMLElement | undefined;
  for (const row of viewport.querySelectorAll<HTMLElement>("[data-transcript-id]")) {
    const bounds = row.getBoundingClientRect();
    if (bounds.height === 0 || bounds.bottom <= from || bounds.top >= bottom) continue;
    if (element !== undefined && !element.contains(row)) break;
    element = row;
  }
  return element;
};

/** Returns the deepest visible transcript row, preferring rows with more than `VISIBLE_ROW_EDGE` pixels in view. */
export const visibleTranscriptRow = (viewport: HTMLDivElement): HTMLElement | undefined => {
  const top = viewport.getBoundingClientRect().top + viewport.clientTop;
  const bottom = top + viewport.clientHeight;
  return deepestRow(viewport, top + VISIBLE_ROW_EDGE, bottom) ?? deepestRow(viewport, top, bottom);
};

/** Keeps a visible transcript row in place as content changes; anchors are elements with `data-transcript-id`. */
export class PreserveReadingPosition extends Component<
  Props,
  Record<string, never>,
  ReadingPosition | null
> {
  private pendingPosition: ReadingPosition | null = null;

  override getSnapshotBeforeUpdate(previous: Props): ReadingPosition | null {
    if (
      !previous.active ||
      (previous.active === this.props.active && previous.revision === this.props.revision)
    )
      return null;
    const viewport = this.props.viewportRef.current;
    if (
      viewport === null ||
      viewport.clientHeight === 0 ||
      viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 8
    )
      return null;

    const top = viewport.getBoundingClientRect().top + viewport.clientTop;
    const element = visibleTranscriptRow(viewport);
    return element === undefined
      ? null
      : {
          viewport,
          element,
          identity: element.getAttribute("data-transcript-id"),
          offset: element.getBoundingClientRect().top - top,
        };
  }

  override componentDidUpdate(
    _previous: Props,
    _state: Record<string, never>,
    position: ReadingPosition | null,
  ) {
    if (position !== null) this.pendingPosition = position;
    if (!this.props.active || this.pendingPosition === null) return;
    const viewport = this.props.viewportRef.current;
    if (viewport === null || viewport.clientHeight === 0) return;
    const readingPosition = this.pendingPosition;
    this.pendingPosition = null;
    if (viewport !== readingPosition.viewport) return;
    // A completed call can move into a group; its ID still matches the element React remounts.
    const element = viewport.contains(readingPosition.element)
      ? readingPosition.element
      : Array.from(viewport.querySelectorAll<HTMLElement>("[data-transcript-id]")).find(
          (row) => row.getAttribute("data-transcript-id") === readingPosition.identity,
        );
    if (element === undefined) return;
    const top = viewport.getBoundingClientRect().top + viewport.clientTop;
    const offset = element.getBoundingClientRect().top - top;
    viewport.scrollTop += offset - readingPosition.offset;
  }

  override render() {
    return this.props.children;
  }
}

import { Component, type ReactNode, type RefObject } from "react";

interface Props {
  readonly viewportRef: RefObject<HTMLDivElement | null>;
  /** Changes when transcript rows grow or change. */
  readonly revision: number;
  /** Hidden tabs retain their last visible row until the viewport is shown again. */
  readonly active: boolean;
  readonly children: ReactNode;
}

interface ReadingPosition {
  readonly viewport: HTMLDivElement;
  readonly element: HTMLElement;
  readonly identity: string | null;
  readonly offset: number;
}

/** Finds the deepest visible transcript surface, so child and result growth preserve context. */
export const visibleTranscriptRow = (viewport: HTMLDivElement): HTMLElement | undefined => {
  const top = viewport.getBoundingClientRect().top + viewport.clientTop;
  const bottom = top + viewport.clientHeight;
  let element: HTMLElement | undefined;
  for (const row of viewport.querySelectorAll<HTMLElement>("[data-transcript-id]")) {
    const bounds = row.getBoundingClientRect();
    if (bounds.height === 0 || bounds.bottom <= top || bounds.top >= bottom) continue;
    if (element !== undefined && !element.contains(row)) break;
    element = row;
  }
  return element;
};

/**
 * Keeps a visible transcript row in place while the operator reads earlier activity.
 * Rows marked with data-transcript-id provide anchors, including events inside child sessions.
 */
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
    // Completing a call can move it into a group. Its durable identity also
    // identifies the replacement panel after React reparents that tool.
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

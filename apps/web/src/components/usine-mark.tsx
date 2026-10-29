import type { CSSProperties } from "react";
import { cn } from "~/lib/utils";

/** The tiles in the order work moves through the cell, on a 64-unit grid, with their static opacity. */
const tiles = [
  { x: 4, y: 4, opacity: 0.3 },
  { x: 4, y: 24, opacity: 0.4 },
  { x: 4, y: 44, opacity: 0.5 },
  { x: 24, y: 44, opacity: 0.62 },
  { x: 44, y: 44, opacity: 0.74 },
  { x: 44, y: 24, opacity: 0.87 },
  { x: 44, y: 4, opacity: 1 },
] as const;

/** `--tile` is the tile's position in the flow; the running animation delays each tile by it. */
type TileStyle = CSSProperties & { readonly "--tile": number };

const tileStyle = (index: number): TileStyle => ({ "--tile": index });

type UsineMarkProps = {
  /** Animates the tiles, unless the reader prefers reduced motion. */
  readonly running?: boolean;
  readonly className?: string;
};

/**
 * Renders the usine mark: seven tiles in the current text color around a dot in the primary color.
 * Size it with `className`. Hidden from assistive technology.
 */
export const UsineMark = ({ running = false, className }: UsineMarkProps) => (
  <svg
    data-slot="usine-mark"
    data-running={running ? "" : undefined}
    viewBox="0 0 64 64"
    aria-hidden="true"
    focusable="false"
    className={cn("shrink-0", className)}
  >
    {tiles.map(({ x, y, opacity }, index) => (
      <rect
        key={`${x},${y}`}
        x={x}
        y={y}
        width="16"
        height="16"
        rx="4"
        fill="currentColor"
        fillOpacity={opacity}
        style={tileStyle(index)}
      />
    ))}
    <circle cx="32" cy="32" r="6" className="fill-primary" />
  </svg>
);

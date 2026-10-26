import type { LoopName } from "@usine/core/loop";
import type { LoopShareView } from "@usine/orchestrator/operator";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { shareLabel } from "./copy.ts";

/** The steps of the loop ramp in `index.css`. */
const RAMP_STEPS = 5;

/** One segment of a share bar: a loop, the loops past the ramp, or the waits. */
export interface SharePart {
  readonly name: string;
  readonly share: number;
  /** A CSS colour. */
  readonly fill: string;
}

/**
 * Returns each loop's share as a part, coloured by the loop's position in `order` on the sapphire
 * ramp. With more loops than ramp steps, the loops from the last step on fold into `other loops`.
 */
export const loopParts = (
  order: ReadonlyArray<LoopName>,
  shares: ReadonlyArray<LoopShareView>,
): ReadonlyArray<SharePart> => {
  const folds = order.length > RAMP_STEPS;
  const parts: Array<SharePart> = [];
  let other = 0;
  for (const { loop, share } of shares) {
    const position = order.indexOf(loop);
    if (folds && position >= RAMP_STEPS - 1) other += share;
    else parts.push({ name: loop, share, fill: `var(--loop-${Math.max(0, position) + 1})` });
  }
  return other > 0
    ? [...parts, { name: "other loops", share: other, fill: `var(--loop-${RAMP_STEPS})` }]
    : parts;
};

export const waitingPart = (share: number): SharePart => ({
  name: "waiting",
  share,
  fill: "var(--loop-waiting)",
});

/**
 * Renders one horizontal bar split into `parts`, 2px apart, with a legend of each part's name and
 * share under it. Hovering a segment or its legend entry dims the others.
 */
export const ShareBar = ({
  label,
  parts,
}: {
  /** The bar's accessible name, such as `Time per task`. */
  readonly label: string;
  readonly parts: ReadonlyArray<SharePart>;
}) => {
  const [hovered, setHovered] = useState<string | null>(null);
  const dimmed = (name: string) => hovered !== null && hovered !== name;
  return (
    <div className="flex flex-col gap-2.5">
      <div
        role="img"
        aria-label={`${label}: ${parts.map(({ name, share }) => `${name} ${shareLabel(share)}`).join(", ")}`}
        className="flex h-3 gap-0.5 overflow-hidden rounded-sm"
        onPointerLeave={() => setHovered(null)}
      >
        {parts.map(({ name, share, fill }) => (
          <div
            key={name}
            className={cn(
              "min-w-0.5 transition-opacity duration-(--duration-fast)",
              dimmed(name) && "opacity-35",
            )}
            style={{ flexGrow: share, flexBasis: 0, background: fill }}
            onPointerEnter={() => setHovered(name)}
          />
        ))}
      </div>
      <ul
        className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"
        onPointerLeave={() => setHovered(null)}
      >
        {parts.map(({ name, share, fill }) => (
          <li
            key={name}
            className={cn(
              "inline-flex items-center gap-1.5 tabular-nums transition-opacity duration-(--duration-fast)",
              dimmed(name) && "opacity-50",
            )}
            onPointerEnter={() => setHovered(name)}
          >
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-[2px]"
              style={{ background: fill }}
            />
            <span className="text-foreground">{name}</span>
            {shareLabel(share)}
          </li>
        ))}
      </ul>
    </div>
  );
};

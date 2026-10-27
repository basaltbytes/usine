import { Option } from "effect";
import type { ComponentType, CSSProperties, ReactNode } from "react";
import { cn } from "~/lib/utils";
import { ItemMark, type ItemRef } from "~/components/item/mark";

/** The props an `ItemHeading` passes to the element it renders. */
type HeadingElementProps = {
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly title?: string;
  readonly children?: ReactNode;
};

type ItemHeadingProps = {
  readonly item: Option.Option<ItemRef>;
  readonly title: string;
  readonly variant: "page" | "row";
  /** Whether the mark links to GitHub; pass `false` inside another link or button. */
  readonly linked?: boolean;
  /** The element to render, such as a dialog title component; `h1` for `page`, `span` for `row`. */
  readonly as?: "h1" | "h2" | "h3" | "p" | "span" | ComponentType<HeadingElementProps>;
  readonly className?: string;
  readonly style?: CSSProperties;
};

/**
 * Renders a title with its item's mark inline before it, in the text flow, so a wrapped line
 * starts under the mark. `page` is a 20px semibold title. `row` is one line in the caller's type
 * (13px medium by default) that truncates the title and keeps the mark, with the title as tooltip.
 */
export const ItemHeading = ({
  item,
  title,
  variant,
  linked = true,
  as: Element = variant === "page" ? "h1" : "span",
  className,
  style,
}: ItemHeadingProps) => (
  <Element
    className={cn(
      variant === "page"
        ? "text-xl font-semibold wrap-anywhere"
        : "block truncate text-sm font-medium",
      className,
    )}
    {...(style === undefined ? {} : { style })}
    {...(variant === "row" ? { title } : {})}
  >
    {Option.match(item, {
      onNone: () => null,
      onSome: (mark) => (
        <>
          <ItemMark
            item={mark}
            size={variant === "page" ? "title" : "inline"}
            linked={linked}
          />{" "}
        </>
      ),
    })}
    {title}
  </Element>
);

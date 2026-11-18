import { BellIcon } from "@phosphor-icons/react";
import { Link, useLocation } from "@tanstack/react-router";
import type { NeedView } from "@usine/orchestrator/operator";
import { useEffect, useState } from "react";
import { NeedsYou } from "./needs-you";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "~/components/ui/sheet";
import { useIsMobile } from "~/hooks/use-mobile";
import {
  attentionTitle,
  attentionBellLabel,
  attentionEmpty,
  attentionOverviewLink,
} from "~/lib/needs-you/strings";

type NotificationTrayProps = { readonly needs: ReadonlyArray<NeedView> };

export const NotificationTray = ({ needs }: NotificationTrayProps) => {
  const mobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const location = useLocation({ select: ({ href }) => href });
  useEffect(() => setOpen(false), [location]);
  const bell = (
    <Button
      size="toolbar"
      variant="ghost"
      className="h-9 shrink-0"
      aria-label={attentionBellLabel(needs.length)}
    >
      <BellIcon aria-hidden="true" className="size-4" />
      {needs.length > 0 && (
        <Badge variant="attention" aria-hidden="true">
          {needs.length}
        </Badge>
      )}
    </Button>
  );
  const title = (
    <>
      {attentionTitle}{" "}
      <span className="ml-2 text-foreground dark:text-needs-you tabular-nums">{needs.length}</span>
    </>
  );
  const content = (
    <>
      <div className="min-h-0 overflow-y-auto overscroll-contain">
        {needs.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">{attentionEmpty}</p>
        ) : (
          <NeedsYou needs={needs} />
        )}
      </div>
      <div className="shrink-0 border-t px-4 py-3">
        <Link
          to="/"
          hash="desk-needs-you"
          onClick={() => setOpen(false)}
          className="rounded-sm text-sm text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-inset"
        >
          {attentionOverviewLink}
        </Link>
      </div>
    </>
  );
  return mobile ? (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={bell} />
      <SheetContent variant="tray" side="bottom" className="max-h-[70dvh]">
        <SheetTitle variant="heading" className="shrink-0">
          {title}
        </SheetTitle>
        {content}
      </SheetContent>
    </Sheet>
  ) : (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={bell} />
      <PopoverContent
        variant="flush"
        align="end"
        sideOffset={8}
        className="max-h-[70dvh] w-100 overflow-hidden"
      >
        <PopoverTitle variant="heading" className="shrink-0">
          {title}
        </PopoverTitle>
        {content}
      </PopoverContent>
    </Popover>
  );
};

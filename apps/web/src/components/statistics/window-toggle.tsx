import type { StatisticsWindow } from "@usine/orchestrator/operator";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { windowLabels } from "~/lib/strings";

const WINDOWS: ReadonlyArray<StatisticsWindow> = ["7d", "30d", "all"];

const isWindow = (value: string | undefined): value is StatisticsWindow =>
  WINDOWS.some((window) => window === value);

type WindowToggleProps = {
  readonly value: StatisticsWindow;
  readonly onChange: (window: StatisticsWindow) => void;
};

/** The statistics window switch: 7 days, 30 days, or all. */
export const WindowToggle = ({ value, onChange }: WindowToggleProps) => (
  <ToggleGroup
    aria-label="Statistics window"
    variant="outline"
    size="sm"
    spacing={0}
    value={[value]}
    onValueChange={([selected]) => {
      if (isWindow(selected)) onChange(selected);
    }}
  >
    {WINDOWS.map((option) => (
      <ToggleGroupItem key={option} value={option}>
        {windowLabels[option]}
      </ToggleGroupItem>
    ))}
  </ToggleGroup>
);

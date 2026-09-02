import type { LabelView } from "@usine/orchestrator";
import { Badge } from "@/components/ui/badge";

const channel = (hex: string, offset: number): number =>
  parseInt(hex.slice(offset, offset + 2), 16);

/** Relative luminance of a six-digit hex color, 0 for black and 1 for white. */
export const luminance = (hex: string): number => {
  const linear = (value: number) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * linear(channel(hex, 0)) +
    0.7152 * linear(channel(hex, 2)) +
    0.0722 * linear(channel(hex, 4))
  );
};

/** GitHub colors are picked for a white page; on the dark theme, dark labels get lifted toward white
 * so the text stays readable, while the tint keeps the original hue. */
export const labelTextColor = (hex: string): string => {
  const lift = Math.max(0, 0.55 - luminance(hex)) / 0.55;
  if (lift === 0) return `#${hex}`;
  const mix = (offset: number) =>
    Math.round(channel(hex, offset) + (255 - channel(hex, offset)) * lift * 0.7);
  return `rgb(${mix(0)} ${mix(2)} ${mix(4)})`;
};

export const LabelBadge = ({
  name,
  label,
}: {
  readonly name: string;
  readonly label: LabelView | undefined;
}) => {
  if (label === undefined || label.color === null) return <Badge variant="outline">{name}</Badge>;
  return (
    <Badge
      variant="outline"
      title={label.description ?? undefined}
      style={{
        color: labelTextColor(label.color),
        borderColor: `#${label.color}66`,
        backgroundColor: `#${label.color}1f`,
      }}
    >
      {name}
    </Badge>
  );
};

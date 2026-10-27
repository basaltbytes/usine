type TasksDoneLegendProps = { readonly points: "dot" | "column" };

export const TasksDoneLegend = ({ points }: TasksDoneLegendProps) => (
  <ul className="flex items-center gap-4 text-xs text-muted-foreground">
    <li className="inline-flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className={
          points === "dot" ? "size-2 rounded-full bg-chart-1" : "size-2 rounded-[2px] bg-chart-1"
        }
      />
      {points === "dot" ? "task" : "tasks"}
    </li>
    <li className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className="h-0.5 w-3 rounded-full bg-muted-foreground" />
      median
    </li>
  </ul>
);

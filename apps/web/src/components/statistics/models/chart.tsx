import type { ModelOutcomeView } from "@usine/orchestrator/operator";
import { Bar, BarChart, LabelList, XAxis, YAxis } from "recharts";
import { ChartTable } from "~/components/statistics/chart-table";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "~/components/ui/chart";
import { firstReviewLabel, firstReviewTitle } from "~/lib/statistics/models";

const config = {
  share: { label: "Passed the first review", color: "var(--chart-1)" },
} satisfies ChartConfig;

type FirstReviewChartProps = { readonly models: ReadonlyArray<ModelOutcomeView> };

/** The share of each model's tasks that passed the first review, as horizontal bars. */
export const FirstReviewChart = ({ models }: FirstReviewChartProps) => {
  const data = models.map((outcome) => ({
    key: `${outcome.model} (${outcome.harness})`,
    model: outcome.model,
    share: Math.round((outcome.firstTimeRight / outcome.tasks) * 100),
    label: firstReviewLabel(outcome),
  }));
  return (
    <>
      <ChartContainer
        config={config}
        className="aspect-auto w-full"
        style={{ height: Math.max(2, data.length) * 28 + 8 }}
      >
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 56, bottom: 4, left: 0 }}>
          <XAxis type="number" hide domain={[0, 100]} />
          <YAxis
            type="category"
            dataKey="key"
            tickLine={false}
            axisLine={false}
            width={140}
            tickFormatter={(key: string) => data.find((entry) => entry.key === key)?.model ?? key}
          />
          <ChartTooltip
            cursor={{ fill: "var(--muted)", fillOpacity: 0.5 }}
            content={
              <ChartTooltipContent
                className="border-0 bg-popover shadow-raised"
                hideIndicator
                formatter={(value, _name, item) =>
                  `${String(value)}% passed the first review (${String(item.payload.label)})`
                }
              />
            }
          />
          <Bar
            dataKey="share"
            fill="var(--color-share)"
            radius={[0, 4, 4, 0]}
            maxBarSize={18}
            isAnimationActive={false}
          >
            <LabelList
              dataKey="label"
              position="right"
              offset={8}
              className="fill-foreground tabular-nums"
            />
          </Bar>
        </BarChart>
      </ChartContainer>
      <ChartTable
        caption={firstReviewTitle}
        head={["Model", "Passed the first review"]}
        rows={data.map(({ key, share, label }) => [key, `${label}, ${share}%`])}
      />
    </>
  );
};

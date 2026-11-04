import { renderToStaticMarkup } from "react-dom/server";
import type { TooltipPayloadEntry } from "recharts";
import { expect, it } from "vitest";

import { ChartContainer, ChartStyle, ChartTooltipContent, type ChartConfig } from "./chart";

const config = {
  name: { label: "Default series" },
  direct: { label: "Direct series" },
  nested: { label: "Nested series" },
} satisfies ChartConfig;

const tooltip = (entry: TooltipPayloadEntry) =>
  renderToStaticMarkup(
    <ChartContainer config={config}>
      <ChartTooltipContent active hideLabel nameKey="name" payload={[entry]} />
    </ChartContainer>,
  );

it("prefers a direct series name over the nested payload name", () => {
  const html = tooltip({
    graphicalItemId: "series",
    name: "direct",
    value: 1200,
    payload: { name: "nested" },
  });

  expect(html).toContain("Direct series");
  expect(html).not.toContain("Nested series");
  expect(html).toContain((1200).toLocaleString());
});

it("uses a nested string series name when the direct name is numeric", () => {
  const html = tooltip({
    graphicalItemId: "series",
    name: 42,
    value: "value",
    payload: { name: "nested" },
  });

  expect(html).toContain("Nested series");
  expect(html).toContain("value");
});

it("uses the indexed series name from a tuple-backed Scatter payload", () => {
  const html = renderToStaticMarkup(
    <ChartContainer config={{ ...config, "0": { label: "Fallback series" } }}>
      <ChartTooltipContent
        active
        hideLabel
        nameKey="0"
        payload={[{ graphicalItemId: "series", value: 1200, payload: ["direct", 1200, 2400] }]}
      />
    </ChartContainer>,
  );

  expect(html).toContain("Direct series");
  expect(html).not.toContain("Fallback series");
});

it("keeps array values comma-separated without locale formatting", () => {
  const html = tooltip({ graphicalItemId: "series", value: [1200, 2400] });
  expect(html).toContain(">1200,2400</span>");
});

it.each([null, { name: 42 }, { name: "missing" }])(
  "uses the requested config key for an unmatched payload: %j",
  (payload) => {
    const html = tooltip({ graphicalItemId: "series", value: 1, payload });
    expect(html).toContain("Default series");
  },
);

it("uses the requested config key when a direct string has no config entry", () => {
  const html = tooltip({
    graphicalItemId: "series",
    name: "missing",
    value: 1,
    payload: { name: "nested" },
  });

  expect(html).toContain("Default series");
  expect(html).not.toContain("Nested series");
});

it("renders the color for each chart theme", () => {
  const html = renderToStaticMarkup(
    <ChartStyle
      id="themed-chart"
      config={{ count: { theme: { light: "var(--chart-1)", dark: "var(--chart-2)" } } }}
    />,
  );

  expect(html).toContain("[data-chart=themed-chart] {\n  --color-count: var(--chart-1);");
  expect(html).toContain(".dark [data-chart=themed-chart] {\n  --color-count: var(--chart-2);");
});

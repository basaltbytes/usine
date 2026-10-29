import { createFileRoute } from "@tanstack/react-router";
import { ConfigurationHistory } from "~/features/configuration/components/editor/history";
import { ConfigurationPage } from "~/features/configuration/components/section";
import { revisionsQuery } from "~/features/configuration/queries";

const History = () => (
  <ConfigurationPage title="Configuration history">
    <ConfigurationHistory />
  </ConfigurationPage>
);

export const Route = createFileRoute("/configuration/history")({
  loader: ({ context }) => context.queryClient.ensureInfiniteQueryData(revisionsQuery()),
  component: History,
});

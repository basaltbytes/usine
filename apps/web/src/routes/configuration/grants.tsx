import { createFileRoute } from "@tanstack/react-router";
import { AllowedCalls } from "~/features/configuration/components/grants/calls";
import { GrantsTable } from "~/features/configuration/components/grants/grants";
import { ConfigurationPage } from "~/features/configuration/components/section";
import { grantCopy } from "~/features/configuration/strings";
import { allowedCallsQuery, grantsQuery } from "~/lib/conversations/queries";

const Grants = () => (
  <ConfigurationPage title={grantCopy.title}>
    <p className="max-w-2xl text-sm text-muted-foreground">{grantCopy.description}</p>
    <GrantsTable />
    <section aria-labelledby="allowed-calls" className="space-y-2">
      <h2 id="allowed-calls" className="text-lg font-semibold">
        {grantCopy.calls}
      </h2>
      <p className="max-w-2xl text-sm text-muted-foreground">{grantCopy.callsDescription}</p>
      <AllowedCalls />
    </section>
  </ConfigurationPage>
);

export const Route = createFileRoute("/configuration/grants")({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(grantsQuery()),
      context.queryClient.ensureQueryData(allowedCallsQuery()),
    ]),
  component: Grants,
});

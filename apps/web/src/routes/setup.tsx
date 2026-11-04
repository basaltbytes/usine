import { createFileRoute } from "@tanstack/react-router";
import { Schema } from "effect";
import { SetupPage } from "~/features/setup/setup.page";
import { setupQuery } from "~/features/setup/queries";
const Search = Schema.Struct({ error: Schema.optionalKey(Schema.String) });
const Setup = () => <SetupPage error={Route.useSearch().error} />;
export const Route = createFileRoute("/setup")({
  validateSearch: Schema.decodeUnknownSync(Search),
  loader: ({ context }) => context.queryClient.ensureQueryData(setupQuery()),
  component: Setup,
});

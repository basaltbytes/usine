import { createFileRoute } from "@tanstack/react-router";
import { TokensPage } from "~/features/tokens/tokens.page";
import { tokensQuery } from "~/features/tokens/queries";
export const Route = createFileRoute("/tokens")({
  loader: ({ context }) => context.queryClient.ensureQueryData(tokensQuery()),
  component: TokensPage,
});

import { createFileRoute } from "@tanstack/react-router";
import { Schema } from "effect";
import { SignInPage } from "~/features/sign-in/sign-in.page";
import { signInQuery } from "~/features/sign-in/queries";
const Search = Schema.Struct({ error: Schema.optionalKey(Schema.String) });
const SignIn = () => <SignInPage error={Route.useSearch().error} />;
export const Route = createFileRoute("/sign-in")({
  validateSearch: Schema.decodeUnknownSync(Search),
  loader: ({ context }) => context.queryClient.ensureQueryData(signInQuery()),
  component: SignIn,
});

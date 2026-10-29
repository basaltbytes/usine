import { Schema } from "effect";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { ErrorAlert } from "~/components/error-alert";
import { authRequest } from "~/lib/auth";
import { rejectionMessage } from "~/lib/api";
import { signInQuery } from "./queries";
import { githubSignIn, localSignIn, openingSession, title } from "./strings";

type SignInPageProps = { readonly error: string | undefined };
export const SignInPage = ({ error }: SignInPageProps) => {
  const { data } = useSuspenseQuery(signInQuery());
  const [failure, setFailure] = useState(error);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const consume = () => {
      const token = new URLSearchParams(window.location.hash.slice(1)).get("link");
      if (token === null) return;
      window.history.replaceState(null, "", window.location.pathname);
      setFailure(undefined);
      setPending(true);
      void authRequest(
        "/api/auth/link/consume",
        Schema.Struct({ ok: Schema.Boolean, bootstrap: Schema.Boolean }),
        {
          method: "POST",
          body: { token },
        },
      ).then(
        (result) =>
          window.location.replace(result.bootstrap && data.github ? "/api/auth/github" : "/"),
        (cause: unknown) => {
          setFailure(rejectionMessage(cause));
          setPending(false);
        },
      );
    };
    consume();
    window.addEventListener("hashchange", consume);
    return () => window.removeEventListener("hashchange", consume);
  }, [data.github]);
  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-6">
      <section className="w-full max-w-sm space-y-6" aria-labelledby="sign-in-title">
        <h1 id="sign-in-title" className="text-xl font-semibold">
          {title}
        </h1>
        {failure !== undefined && <ErrorAlert message={failure} />}
        {pending ? (
          <p role="status" className="text-sm text-muted-foreground">
            {openingSession}
          </p>
        ) : (
          <>
            {data.github && <Button render={<a href="/api/auth/github" />}>{githubSignIn}</Button>}
            <p className="text-sm text-muted-foreground">{localSignIn}</p>
          </>
        )}
      </section>
    </main>
  );
};

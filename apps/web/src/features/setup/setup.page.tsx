import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { Label } from "~/components/ui/label";
import { ErrorAlert } from "~/components/error-alert";
import { Acknowledged, authRequest } from "~/lib/auth";
import { rejectionMessage } from "~/lib/api";
import { prepareManifest, setupQuery, activateInstance } from "./queries";
import {
  steps,
  title as pageTitle,
  openingInstance,
  appName,
  organizationLabel,
  organizationHint,
  creatingApp,
  createApp,
  restoreTitle,
  restoreHelp,
  credentialsLabel,
  saving,
  restore as restoreLabel,
  install,
  checking,
  recheck,
  signInHelp,
  signIn as signInLabel,
  missingSignIn,
  pickRepositories,
  continueToInstance,
} from "./strings";

type SetupPageProps = { readonly error?: string | undefined };
export const SetupPage = ({ error }: SetupPageProps) => {
  const query = useSuspenseQuery(setupQuery());
  const state = query.data;
  const [name, setName] = useState("usine");
  const [organization, setOrganization] = useState("");
  const [credentials, setCredentials] = useState("");
  const create = useMutation({
    mutationFn: () => prepareManifest(name, organization),
    onSuccess: ({ action, manifest }) => {
      const form = document.createElement("form");
      form.method = "POST";
      form.action = action;
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "manifest";
      input.value = manifest;
      form.append(input);
      document.body.append(form);
      form.requestSubmit();
      form.remove();
    },
  });
  const save = useMutation({
    mutationFn: () =>
      authRequest("/api/setup/restore", Acknowledged, { method: "POST", body: { credentials } }),
    onSuccess: async () => {
      setCredentials("");
      await query.refetch();
    },
  });
  const activate = useMutation({
    mutationFn: async (destination: string) => {
      await activateInstance();
      window.location.assign(destination);
    },
  });
  const failure = create.error ?? save.error ?? activate.error ?? query.error;
  const heading = steps[state._tag];
  return (
    <main className="min-h-svh bg-background px-6 py-12 sm:py-20">
      <section className="mx-auto w-full max-w-lg space-y-8" aria-labelledby="setup-title">
        <h1 id="setup-title" className="text-xl font-semibold">
          {pageTitle}
        </h1>
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">{heading.title}</h2>
          <p className="text-sm text-muted-foreground">{heading.description}</p>
        </div>
        {error !== undefined && <ErrorAlert message={error} />}
        {failure !== null && <ErrorAlert message={rejectionMessage(failure)} />}
        {state._tag === "MissingKey" && <ErrorAlert message={state.message} />}
        {(state._tag === "NoApp" || state._tag === "MissingKey") && (
          <>
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                create.mutate();
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="app-name">{appName}</Label>
                <Input
                  id="app-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  maxLength={34}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="app-organization">{organizationLabel}</Label>
                <Input
                  id="app-organization"
                  value={organization}
                  onChange={(event) => setOrganization(event.target.value)}
                  autoComplete="off"
                  aria-describedby="organization-hint"
                />
                <p id="organization-hint" className="text-sm text-muted-foreground">
                  {organizationHint}
                </p>
              </div>
              <Button type="submit" disabled={create.isPending || save.isPending}>
                {create.isPending ? creatingApp : createApp}
              </Button>
            </form>
            <details className="space-y-4 border-t pt-5" open={state._tag === "MissingKey"}>
              <summary className="cursor-pointer text-md font-medium">{restoreTitle}</summary>
              <p className="text-sm text-muted-foreground">{restoreHelp}</p>
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  save.mutate();
                }}
              >
                <Label htmlFor="app-credentials">{credentialsLabel}</Label>
                <Textarea
                  id="app-credentials"
                  value={credentials}
                  onChange={(event) => setCredentials(event.target.value)}
                  required
                  autoComplete="off"
                  spellCheck={false}
                  rows={7}
                />
                <Button type="submit" disabled={save.isPending || create.isPending}>
                  {save.isPending ? saving : restoreLabel}
                </Button>
              </form>
            </details>
          </>
        )}
        {state._tag === "NeedsInstallation" && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{state.message}</p>
            <div className="flex flex-wrap gap-3">
              <Button nativeButton={false} render={<a href={state.url} />}>
                {install}
              </Button>
              <Button
                variant="outline"
                disabled={query.isFetching}
                onClick={() => {
                  void query.refetch();
                }}
              >
                {query.isFetching ? checking : recheck}
              </Button>
            </div>
          </div>
        )}
        {state._tag === "Repositories" &&
          (state.signIn ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">{signInHelp}</p>
              {state.github ? (
                <Button nativeButton={false} render={<a href="/api/auth/github" />}>
                  {signInLabel}
                </Button>
              ) : (
                <ErrorAlert message={missingSignIn} />
              )}
            </div>
          ) : (
            <Button
              disabled={activate.isPending}
              onClick={() => activate.mutate("/configuration/repositories")}
            >
              {activate.isPending ? openingInstance : pickRepositories}
            </Button>
          ))}
        {state._tag === "Ready" && (
          <Button disabled={activate.isPending} onClick={() => activate.mutate("/")}>
            {activate.isPending ? openingInstance : continueToInstance}
          </Button>
        )}
      </section>
    </main>
  );
};

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  ProviderLoginView as ProviderLoginViewSchema,
  type LoginProvider,
  type ProviderConnection,
  type ProviderLoginView,
} from "@usine/gateway/credentials";
import { CommandButton } from "~/components/command-palette/button";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { ErrorAlert } from "~/components/error-alert";
import { Acknowledged, authRequest } from "~/lib/auth";
import { rejectionMessage } from "~/lib/api";
import { providersQuery } from "~/lib/providers/queries";
import {
  cancelLogin,
  cancelled,
  codeLabel,
  connect,
  connected,
  disconnect,
  disconnected,
  expires,
  keyKind,
  keyLabel,
  lastRefresh,
  opening,
  pending,
  providerNames,
  replace,
  saveKey,
  starting,
  submitCode,
  subscriptionKind,
  unknownTime,
  useKey,
  working,
} from "./strings";

type ProviderConnectionRowProps = {
  readonly target: string;
  readonly provider: LoginProvider;
  readonly connection: ProviderConnection;
  readonly login: ProviderLoginView | undefined;
};
export const ProviderConnectionRow = ({
  target,
  provider,
  connection,
  login,
}: ProviderConnectionRowProps) => {
  const queries = useQueryClient();
  const [key, setKey] = useState("");
  const [code, setCode] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const name = providerNames[provider];
  const action = useMutation({
    gcTime: 0,
    mutationFn: ({
      path,
      method,
      body,
    }: {
      path: string;
      method: string;
      body?: Record<string, string>;
    }) =>
      body === undefined
        ? authRequest(path, Acknowledged, { method })
        : authRequest(path, Acknowledged, { method, body }),
    onMutate: () => setActionError(null),
    onError: (error) => setActionError(rejectionMessage(error)),
    onSuccess: () => queries.invalidateQueries(providersQuery()),
    onSettled: () => {
      setKey("");
      setCode("");
      action.reset();
    },
  });
  const begin = useMutation({
    mutationFn: () =>
      authRequest("/api/providers/login", ProviderLoginViewSchema, {
        method: "POST",
        body: { target, provider },
      }),
    onSuccess: () => queries.invalidateQueries(providersQuery()),
  });
  const state = login?.state;
  const waiting = state?.status === "starting" || state?.status === "authorizing";
  const busy = action.isPending || begin.isPending;
  const failure = actionError ?? (begin.error === null ? null : rejectionMessage(begin.error));
  return (
    <section className="flex flex-col gap-3 border-t py-4" aria-label={name}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h3 className="font-medium">{name}</h3>
          <p className="text-xs text-muted-foreground" role="status">
            {connection.credential === null
              ? disconnected
              : `${connected} · ${connection.credential === "api-key" ? keyKind : subscriptionKind}`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <CommandButton
            command={connection.credential === null ? connect(name) : replace(name)}
            variant="outline"
            disabled={busy || waiting}
            onClick={() => begin.mutate()}
          >
            {connection.credential === null ? connect(name) : replace(name)}
          </CommandButton>
          {connection.credential !== null && (
            <CommandButton
              command={disconnect(name)}
              variant="ghost"
              disabled={busy}
              onClick={() =>
                action.mutate({
                  path: "/api/providers/disconnect",
                  method: "POST",
                  body: { target, provider },
                })
              }
            >
              {disconnect(name)}
            </CommandButton>
          )}
        </div>
      </div>
      {connection.credential === "subscription" && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <dt>{expires}</dt>
          <dd>{connection.expiresAt ?? unknownTime}</dd>
          <dt>{lastRefresh}</dt>
          <dd>{connection.lastRefresh ?? unknownTime}</dd>
        </dl>
      )}
      {state?.status === "starting" && (
        <p role="status" className="text-muted-foreground">
          {starting}
        </p>
      )}
      {state?.status === "authorizing" && (
        <div className="space-y-3">
          <Button
            nativeButton={false}
            variant="outline"
            render={<a href={state.url} target="_blank" rel="noreferrer" />}
          >
            {opening}
          </Button>
          {state.code !== null && <p className="font-mono text-md select-all">{state.code}</p>}
          {provider === "claude" ? (
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (login !== undefined)
                  action.mutate({
                    path: "/api/providers/code",
                    method: "POST",
                    body: { id: login.id, code },
                  });
              }}
            >
              <Label htmlFor={`${target}-${provider}-code`}>{codeLabel}</Label>
              <Input
                id={`${target}-${provider}-code`}
                type="password"
                autoComplete="off"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                required
              />
              <Button type="submit" disabled={busy}>
                {busy ? working : submitCode}
              </Button>
            </form>
          ) : (
            <p role="status" className="text-muted-foreground">
              {pending}
            </p>
          )}
        </div>
      )}
      {waiting && login !== undefined && (
        <Button
          className="w-fit"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            action.mutate({ path: `/api/providers/login/${login.id}`, method: "DELETE" })
          }
        >
          {cancelLogin}
        </Button>
      )}
      {state?.status === "failed" && <ErrorAlert message={state.message} />}
      {state?.status === "cancelled" && (
        <p role="status" className="text-muted-foreground">
          {cancelled}
        </p>
      )}
      {!waiting && (
        <details className="space-y-3">
          <summary className="w-fit cursor-pointer text-xs text-muted-foreground">{useKey}</summary>
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              action.mutate({
                path: "/api/providers/key",
                method: "PUT",
                body: { target, provider, key },
              });
            }}
          >
            <Label htmlFor={`${target}-${provider}-key`}>{keyLabel}</Label>
            <Input
              id={`${target}-${provider}-key`}
              type="password"
              autoComplete="off"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              required
            />
            <Button type="submit" disabled={busy}>
              {busy ? working : saveKey}
            </Button>
          </form>
        </details>
      )}
      {failure !== null && <ErrorAlert message={failure} />}
    </section>
  );
};

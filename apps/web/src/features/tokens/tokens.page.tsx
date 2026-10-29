import { CommandButton } from "~/components/command-palette/button";
import { PageHeading } from "~/components/page";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { ErrorAlert } from "~/components/error-alert";
import { Acknowledged, authRequest } from "~/lib/auth";
import { rejectionMessage } from "~/lib/api";
import { tokensQuery } from "./queries";
import {
  title,
  description,
  empty,
  revoke,
  confirmRevoke,
  keepToken,
  lastUsed,
  created,
} from "./strings";

export const TokensPage = () => {
  const { data } = useSuspenseQuery(tokensQuery());
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const remove = async (id: string) => {
    setPending(true);
    setError(undefined);
    try {
      await authRequest(`/api/tokens/${encodeURIComponent(id)}`, Acknowledged, {
        method: "DELETE",
      });
      setSelected(undefined);
      await queryClient.invalidateQueries(tokensQuery());
    } catch (cause) {
      setError(rejectionMessage(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="space-y-6 p-4 md:p-5">
      <div>
        <PageHeading title={title} />
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      </div>
      {error !== undefined && <ErrorAlert message={error} />}
      {data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y divide-border">
          {data.map((token) => (
            <li key={token.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div>
                <p className="text-sm font-medium">{token.name}</p>
                <p className="text-xs text-muted-foreground">
                  {created} {new Date(token.createdAt).toLocaleDateString()} · {lastUsed}{" "}
                  {new Date(token.lastUsedAt).toLocaleString()}
                </p>
              </div>
              <div className="flex gap-2">
                {selected === token.id ? (
                  <>
                    <Button
                      variant="destructive"
                      disabled={pending}
                      onClick={() => void remove(token.id)}
                    >
                      {confirmRevoke}
                    </Button>
                    <Button variant="ghost" onClick={() => setSelected(undefined)}>
                      {keepToken}
                    </Button>
                  </>
                ) : (
                  <CommandButton
                    command={`${revoke} · ${token.name} · ${token.id}`}
                    variant="ghost"
                    disabled={pending}
                    onClick={() => setSelected(token.id)}
                  >
                    {revoke}
                  </CommandButton>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

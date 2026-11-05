import { ErrorAlert } from "~/components/error-alert";
import { Button } from "~/components/ui/button";
import { rejectionMessage } from "~/lib/api";
import { useQuery } from "@tanstack/react-query";
import { providersQuery } from "~/lib/providers/queries";
import { ProviderConnectionRow, ProviderUnavailableRow } from "./connection";
import { providersTitle, providersHelp, targetLabel, refreshProviders } from "./strings";

export const ProviderConnections = () => {
  const { data, error, refetch } = useQuery(providersQuery());
  return (
    <section className="space-y-3" aria-labelledby="provider-connections-title">
      <h2 id="provider-connections-title" className="text-md font-semibold">
        {providersTitle}
      </h2>
      <p className="text-muted-foreground">{providersHelp}</p>
      {error !== null && <ErrorAlert message={rejectionMessage(error)} />}
      {data === undefined ? (
        <Button
          variant="outline"
          onClick={() => {
            void refetch();
          }}
        >
          {refreshProviders}
        </Button>
      ) : (
        data.targets.map((destination) => {
          const { target, label } = destination;
          return (
            <div key={target}>
              <p className="pb-2 text-xs text-muted-foreground">{targetLabel(label)}</p>
              {"error" in destination ? (
                <ErrorAlert message={destination.error} />
              ) : (
                destination.providers.map((connection) => {
                  const provider =
                    connection.provider === "anthropic-messages" ? "claude" : "chatgpt";
                  return "error" in connection ? (
                    <ProviderUnavailableRow
                      key={provider}
                      provider={provider}
                      message={connection.error}
                    />
                  ) : (
                    <ProviderConnectionRow
                      key={provider}
                      target={target}
                      provider={provider}
                      connection={connection}
                      login={data.logins.find(
                        (login) => login.target === target && login.provider === provider,
                      )}
                    />
                  );
                })
              )}
            </div>
          );
        })
      )}
    </section>
  );
};

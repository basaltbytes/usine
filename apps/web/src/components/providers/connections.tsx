import { ErrorAlert } from "~/components/error-alert";
import { Button } from "~/components/ui/button";
import { rejectionMessage } from "~/lib/api";
import { useQuery } from "@tanstack/react-query";
import { providersQuery } from "~/lib/providers/queries";
import { ProviderConnectionRow, ProviderUnavailableRow } from "./connection";
import {
  providerName,
  providersTitle,
  providersHelp,
  targetLabel,
  refreshProviders,
} from "./strings";

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
                destination.providers.map((connection) =>
                  "error" in connection ? (
                    <ProviderUnavailableRow
                      key={connection.provider}
                      name={providerName(connection)}
                      message={connection.error}
                    />
                  ) : (
                    <ProviderConnectionRow
                      key={connection.provider}
                      target={target}
                      connection={connection}
                      login={data.logins.find(
                        (login) =>
                          login.target === target && login.provider === connection.accepts.login,
                      )}
                    />
                  ),
                )
              )}
            </div>
          );
        })
      )}
    </section>
  );
};

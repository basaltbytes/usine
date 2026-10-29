import { useSuspenseQuery } from "@tanstack/react-query";
import { type ErrorComponentProps, Outlet, useRouter } from "@tanstack/react-router";
import { ErrorAlert } from "~/components/error-alert";
import { Page } from "~/components/page";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { usePauseLoop } from "~/features/configuration/queries";
import { rejectionMessage } from "~/lib/api";
import { overviewQuery } from "~/lib/overview";

export const ConfigurationSection = () => <Outlet />;

export const ConfigurationPending = () => (
  <Page width="full">
    <div className="flex items-center justify-between gap-4" aria-busy="true">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-7 w-44" />
    </div>
    <span className="sr-only">Loading the configuration</span>
    <div className="flex flex-col gap-3 pt-3">
      {[0, 1, 2, 3].map((row) => (
        <Skeleton key={row} className="h-5 w-full" />
      ))}
    </div>
  </Page>
);

type ConfigurationUnavailableProps = Readonly<ErrorComponentProps>;

export const ConfigurationUnavailable = ({ error }: ConfigurationUnavailableProps) => {
  const router = useRouter();
  return (
    <Page width="full">
      <ErrorAlert title="Could not load the configuration" message={rejectionMessage(error)} />
      <div>
        <Button variant="outline" onClick={() => void router.invalidate()}>
          Try again
        </Button>
      </div>
    </Page>
  );
};

/** Returns `null` if operator actions are unavailable, as in setup mode. */
export const useLoopPause = () => {
  const pause = usePauseLoop();
  const { data } = useSuspenseQuery(overviewQuery());
  return data._tag === "NeedsSetup" ? null : pause;
};

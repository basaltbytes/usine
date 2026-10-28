import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import type { UpgradeTiming } from "@usine/core/upgrade";
import { UpgradeRequest } from "@usine/orchestrator/operator/http";
import { Option } from "effect";
import { Button } from "~/components/ui/button";
import { upgradeQuery } from "~/features/configuration/queries";
import {
  upgradeRunningLabel,
  upgradeChannelLabel,
  upgradeModeLabel,
  upgradeAvailable,
  upgradesTitle,
  upgradeWhenIdle,
  upgradeNow,
  upgradeChanges,
  upgradeIdleHelp,
  upgradeNowHelp,
  upgradeUnsupported,
  upgradeCurrent,
  upgradeOff,
  upgradeWaiting,
  upgradeInstalling,
  upgradeRolledBack,
} from "~/features/configuration/strings";
import { api, rejectionMessage } from "~/lib/api";

const releaseRef = (version: string) =>
  /-next\.\d+\.g([0-9a-f]{7,40})$/u.exec(version)?.[1] ?? `@usine/server@${version}`;

export const Upgrades = () => {
  const { data } = useSuspenseQuery(upgradeQuery());
  const queries = useQueryClient();
  const request = useMutation({
    mutationFn: (timing: UpgradeTiming) =>
      api((client) =>
        client.requestUpgrade({
          payload: new UpgradeRequest({ timing, version: Option.none() }),
        }),
      ),
    onSuccess: () => queries.invalidateQueries(upgradeQuery()),
  });
  const busy = data.phase === "waiting" || data.phase === "installing";
  const compare =
    data.available === null
      ? null
      : `https://github.com/basaltbytes/usine/compare/${encodeURIComponent(releaseRef(data.running))}...${encodeURIComponent(releaseRef(data.available))}`;
  return (
    <section className="flex flex-col gap-3" aria-labelledby="upgrades-title">
      <h2 id="upgrades-title" className="text-md font-semibold">
        {upgradesTitle}
      </h2>
      <dl className="grid gap-x-6 gap-y-2 border-y py-3 sm:grid-cols-[16rem_minmax(0,1fr)]">
        <dt className="text-muted-foreground">{upgradeRunningLabel}</dt>
        <dd className="font-mono text-xs">{data.running}</dd>
        <dt className="text-muted-foreground">{upgradeChannelLabel}</dt>
        <dd>{data.channel}</dd>
        <dt className="text-muted-foreground">{upgradeModeLabel}</dt>
        <dd>{data.mode}</dd>
      </dl>
      {!data.supported ? (
        <p className="text-muted-foreground">{upgradeUnsupported}</p>
      ) : (
        <>
          <p role="status">
            {data.phase === "waiting"
              ? upgradeWaiting
              : data.phase === "installing"
                ? upgradeInstalling
                : data.mode === "off"
                  ? upgradeOff
                  : data.available === null
                    ? upgradeCurrent
                    : upgradeAvailable(data.available)}
          </p>
          {compare !== null && (
            <a
              href={compare}
              target="_blank"
              rel="noreferrer"
              className="w-fit text-primary underline underline-offset-4"
            >
              {upgradeChanges}
            </a>
          )}
          {data.available !== null && !busy && data.phase !== "failed" && (
            <div className="flex flex-col gap-4 sm:flex-row sm:gap-8">
              <div className="flex max-w-sm flex-col items-start gap-2">
                <Button disabled={request.isPending} onClick={() => request.mutate("idle")}>
                  {upgradeWhenIdle}
                </Button>
                <p className="text-xs text-muted-foreground">{upgradeIdleHelp}</p>
              </div>
              <div className="flex max-w-sm flex-col items-start gap-2">
                <Button
                  variant="outline"
                  disabled={request.isPending}
                  onClick={() => request.mutate("now")}
                >
                  {upgradeNow}
                </Button>
                <p className="text-xs text-muted-foreground">{upgradeNowHelp}</p>
              </div>
            </div>
          )}
        </>
      )}
      {data.outcome?.status === "rolled-back" && (
        <p role="alert" className="text-destructive">
          {upgradeRolledBack(data.outcome.previous, data.outcome.target, data.outcome.reason)}
        </p>
      )}
      {data.outcome?.status === "failed" && (
        <p role="alert" className="text-destructive">
          {data.outcome.reason}
        </p>
      )}
      {data.message !== null && (
        <p role="alert" className="text-destructive">
          {data.message}
        </p>
      )}
      {request.isError && (
        <p role="alert" className="text-destructive">
          {rejectionMessage(request.error)}
        </p>
      )}
    </section>
  );
};

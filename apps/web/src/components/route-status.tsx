import { type ErrorComponentProps, useRouter } from "@tanstack/react-router";
import { BootScreen } from "~/components/boot-screen";
import { Button } from "~/components/ui/button";
import { rejectionMessage } from "~/lib/api";
import { loadingPage, pageUnavailable, tryAgain } from "~/lib/strings";

export const RoutePending = () => <BootScreen title="usine" description={loadingPage} inPanel />;

type RouteErrorProps = Readonly<ErrorComponentProps>;

export const RouteError = ({ error }: RouteErrorProps) => {
  const router = useRouter();
  return (
    <BootScreen title={pageUnavailable} description={rejectionMessage(error)} tone="error" inPanel>
      <Button variant="outline" onClick={() => void router.invalidate()}>
        {tryAgain}
      </Button>
    </BootScreen>
  );
};

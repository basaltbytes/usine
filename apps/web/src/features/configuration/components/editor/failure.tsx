import {
  ConfigurationInvalidRefusal,
  ConfigurationRevertRefusal,
} from "@usine/orchestrator/operator/http";
import { ErrorAlert } from "~/components/error-alert";
import { rejectionMessage } from "~/lib/api";

type WriteFailureProps = { readonly error: Error };

export const WriteFailure = ({ error }: WriteFailureProps) => (
  <div role="alert" className="min-w-0 space-y-2 wrap-anywhere">
    <ErrorAlert message={rejectionMessage(error)} />
    {error instanceof ConfigurationInvalidRefusal && (
      <ul className="space-y-1 text-destructive">
        {error.problems.map((problem, index) => (
          <li key={index}>
            <code>
              {problem.entity.key}
              {problem.path.length > 0 ? `.${problem.path.join(".")}` : ""}
            </code>
            : {problem.message}
          </li>
        ))}
      </ul>
    )}
    {error instanceof ConfigurationRevertRefusal && (
      <ul className="text-destructive">
        {error.entities.map((key) => (
          <li key={key.key}>{key.key}</li>
        ))}
      </ul>
    )}
  </div>
);

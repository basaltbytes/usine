import {
  CaretRightIcon,
  CheckCircleIcon,
  HandPalmIcon,
  KanbanIcon,
  ProhibitIcon,
  SquaresFourIcon,
  WarningCircleIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { InstanceScope, ProjectScope } from "@usine/core/access";
import type { Answer } from "@usine/core/permission-request";
import { Option, Schema } from "effect";
import type { ReactNode } from "react";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from "~/components/ai-elements/code-block";
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
  type ConfirmationState,
} from "~/components/ai-elements/confirmation";
import { ErrorAlert } from "~/components/error-alert";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";
import { UsineMark } from "~/components/usine-mark";
import { useAnswerRequest } from "~/hooks/use-answer-request";
import { useScopeName } from "~/hooks/use-conversation-access";
import { rejectionMessage } from "~/lib/api";
import {
  allowanceLabel,
  type ArgumentRow,
  argumentRows,
  argumentsFit,
  callOutcome,
  type RequestTone,
  requestTone,
} from "~/lib/conversations/requests";
import {
  allowAlwaysLabel,
  allowOnceLabel,
  answerNeedsLabel,
  argumentsLabel,
  deniedLabel,
  denyLabel,
  instanceSubject,
  noArgumentsLabel,
  permissionRequestLabel,
  resultLabel,
  waitingAnswerLabel,
} from "~/lib/conversations/strings";
import type { PermissionRequest } from "~/lib/conversations/timeline";

const marks = {
  waiting: <HandPalmIcon className="text-needs-you" />,
  running: <UsineMark running className="text-run-active" />,
  ran: <CheckCircleIcon className="text-run-succeeded" />,
  failed: <XCircleIcon className="text-destructive" />,
  denied: <ProhibitIcon className="text-muted-foreground" />,
  interrupted: <WarningCircleIcon className="text-destructive" />,
} satisfies Record<RequestTone, ReactNode>;

const confirmation = (tone: RequestTone): ConfirmationState =>
  tone === "waiting" ? "requested" : tone === "denied" ? "rejected" : "accepted";

type ArgumentListProps = { readonly rows: ReadonlyArray<ArgumentRow> };

const ArgumentList = ({ rows }: ArgumentListProps) => (
  <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 font-mono text-xs">
    {rows.map(({ name, value }, index) => (
      <div key={`${name}:${index}`} className="contents">
        <dt className="text-muted-foreground">{name}</dt>
        <dd className="min-w-0 whitespace-pre-wrap wrap-anywhere">{value}</dd>
      </div>
    ))}
  </dl>
);

type ArgumentsProps = { readonly request: PermissionRequest };

/** The call's arguments, open when they are short and folded otherwise. */
const Arguments = ({ request }: ArgumentsProps) => {
  const rows = argumentRows(request.arguments);
  if (rows.length === 0) return <p className="text-xs text-muted-foreground">{noArgumentsLabel}</p>;
  if (argumentsFit(rows)) return <ArgumentList rows={rows} />;
  return (
    <Collapsible>
      <CollapsibleTrigger
        render={
          <Button
            tone="muted"
            variant="ghost"
            size="inline"
            className="relative before:absolute before:-inset-2 data-[panel-open]:[&_svg]:rotate-90"
          />
        }
      >
        <CaretRightIcon aria-hidden="true" className="transition-transform" />
        {argumentsLabel} · {rows.length}
      </CollapsibleTrigger>
      <CollapsibleContent className="collapsible-motion mt-2 max-h-64 overflow-auto border-l pl-3">
        <ArgumentList rows={rows} />
      </CollapsibleContent>
    </Collapsible>
  );
};

const decodeJson = Schema.decodeOption(Schema.fromJsonString(Schema.Json));
const isJson = (text: string) => Option.isSome(decodeJson(text));

type ResultProps = { readonly text: string };

/** The operation's response, folded. */
const Result = ({ text }: ResultProps) => (
  <Collapsible>
    <CollapsibleTrigger
      render={
        <Button
          tone="muted"
          variant="ghost"
          size="inline"
          className="relative before:absolute before:-inset-2 data-[panel-open]:[&_svg]:rotate-90"
        />
      }
    >
      <CaretRightIcon aria-hidden="true" className="transition-transform" />
      {resultLabel}
    </CollapsibleTrigger>
    <CollapsibleContent className="collapsible-motion mt-2">
      <CodeBlock code={text} language={isJson(text) ? "json" : "text"} wrap className="max-h-64">
        <CodeBlockHeader>
          <CodeBlockTitle>{resultLabel}</CodeBlockTitle>
          <CodeBlockActions>
            <CodeBlockCopyButton />
          </CodeBlockActions>
        </CodeBlockHeader>
      </CodeBlock>
    </CollapsibleContent>
  </Collapsible>
);

type OutcomeProps = {
  readonly request: PermissionRequest;
  readonly project: string;
};

/** Who allowed the call and what it did. */
const Outcome = ({ request, project }: OutcomeProps) => {
  const { state } = request;
  if (state._tag === "Waiting" || state._tag === "Denied") return null;
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {allowanceLabel(state.allowance, project)}
        {" · "}
        <span className={state._tag === "Ran" ? "text-foreground" : undefined}>
          {callOutcome(state).label}
        </span>
      </p>
      {state._tag === "Failed" && (
        <p className="max-h-32 overflow-auto text-sm whitespace-pre-wrap text-destructive wrap-anywhere">
          {state.error}
        </p>
      )}
      {state._tag === "Ran" && state.result !== "" && <Result text={state.result} />}
    </div>
  );
};

type PermissionRequestBlockProps = { readonly request: PermissionRequest };

/**
 * A supervisor turn's permission request at the place of its call: the operation, its target and
 * scope, its arguments, and the answers that the member can give, then the answer and outcome.
 */
export const PermissionRequestBlock = ({ request }: PermissionRequestBlockProps) => {
  const answer = useAnswerRequest(request.conversation);
  const scope = useScopeName(
    request.project === null
      ? InstanceScope.make()
      : ProjectScope.make({ project: request.project }),
  );
  const tone = requestTone(request);
  const send = (value: Answer) => answer.mutate({ request: request.id, answer: value });
  return (
    <Confirmation
      state={confirmation(tone)}
      aria-label={permissionRequestLabel(request.summary)}
      className="my-1"
    >
      <ConfirmationTitle>
        <span aria-hidden="true" className="mt-0.5 shrink-0 [&_svg]:size-4">
          {marks[tone]}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium text-foreground">{request.summary}</span>
            <span className="font-mono text-xs text-muted-foreground wrap-anywhere">
              {request.target}
            </span>
          </span>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground [&_svg]:size-3.5">
            {request.project === null ? (
              <SquaresFourIcon aria-hidden="true" />
            ) : (
              <KanbanIcon aria-hidden="true" />
            )}
            {scope}
          </span>
        </span>
      </ConfirmationTitle>
      <div className="pl-6">
        <Arguments request={request} />
      </div>
      <div className="space-y-2 pl-6">
        <ConfirmationRequest>
          <p className="text-xs text-needs-you">
            {waitingAnswerLabel}
            {!request.answerable && (
              <span className="text-muted-foreground">
                {" · "}
                {answerNeedsLabel(
                  request.permission,
                  request.project === null ? instanceSubject : scope,
                )}
              </span>
            )}
          </p>
        </ConfirmationRequest>
        {request.answerable && (
          <ConfirmationActions>
            <ConfirmationAction
              variant="default"
              disabled={answer.isPending}
              onClick={() => send("once")}
            >
              {allowOnceLabel}
            </ConfirmationAction>
            {request.grantable && (
              <ConfirmationAction disabled={answer.isPending} onClick={() => send("always")}>
                {allowAlwaysLabel(scope)}
              </ConfirmationAction>
            )}
            <ConfirmationAction
              variant="ghost"
              disabled={answer.isPending}
              onClick={() => send("deny")}
            >
              {denyLabel}
            </ConfirmationAction>
          </ConfirmationActions>
        )}
        <ConfirmationAccepted>
          <Outcome request={request} project={scope} />
        </ConfirmationAccepted>
        <ConfirmationRejected>
          {request.state._tag === "Denied" && (
            <p className="text-xs text-muted-foreground">{deniedLabel(request.state.by.login)}</p>
          )}
        </ConfirmationRejected>
        {answer.isError && <ErrorAlert message={rejectionMessage(answer.error)} />}
      </div>
    </Confirmation>
  );
};

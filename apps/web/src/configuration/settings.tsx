import type { ConfigurationView, SettingsView } from "@usine/orchestrator/operator";
import type { ReactNode } from "react";
import { ConfigurationPage } from "./section.tsx";

interface Setting {
  /** The key as `usine.yaml` spells it. */
  readonly key: string;
  readonly value: ReactNode;
  /** What the value does, in a sentence. */
  readonly effect: string;
}

const unset = (text: string) => <span className="text-muted-foreground">{text}</span>;

const mono = (value: string | number) => <code className="font-mono text-xs">{value}</code>;

const groups = (
  settings: SettingsView,
): ReadonlyArray<readonly [string, ReadonlyArray<Setting>]> => [
  [
    "Polling",
    [
      {
        key: "settings.poll_interval",
        value: mono(settings.pollInterval),
        effect: "Seconds between the starts of two GitHub poll cycles.",
      },
    ],
  ],
  [
    "Attempts",
    [
      {
        key: "settings.max_children",
        value: mono(settings.maxChildren),
        effect: "Child sessions one Attempt may start over its lifetime; the next one fails it.",
      },
      {
        key: "settings.max_attempt_minutes",
        value:
          settings.maxAttemptMinutes === null ? unset("Not set") : mono(settings.maxAttemptMinutes),
        effect:
          settings.maxAttemptMinutes === null
            ? "No wall-clock ceiling: an Attempt runs until it ends."
            : "Minutes an Attempt may run before the runaway guard fails it.",
      },
      {
        key: "settings.max_attempt_tokens",
        value:
          settings.maxAttemptTokens === null ? unset("Not set") : mono(settings.maxAttemptTokens),
        effect:
          settings.maxAttemptTokens === null
            ? "No token ceiling."
            : "Tokens, parent and children together, an Attempt may use before the runaway guard fails it.",
      },
    ],
  ],
  [
    "Parent",
    [
      {
        key: "settings.parent_model",
        value: settings.parentModel === null ? unset("Not set") : mono(settings.parentModel),
        effect:
          settings.parentModel === null
            ? "Pi selects the parent's model unless the Agent sets parent_model."
            : "The parent's model when the Agent sets no parent_model.",
      },
      {
        key: "settings.parent_effort",
        value: settings.parentEffort === null ? unset("Not set") : mono(settings.parentEffort),
        effect:
          settings.parentEffort === null
            ? "The parent runs at the Agent's parent_effort, else at the Agent's effort."
            : "The parent's effort when the Agent sets no parent_effort.",
      },
    ],
  ],
  [
    "Operator",
    [
      {
        key: "operator",
        value: settings.operator === null ? unset("Not set") : mono(settings.operator),
        effect:
          settings.operator === null
            ? "Approvals from the UI record no approver, and messages read local operator."
            : "The GitHub login recorded on approvals and messages from the UI, and the only login that can answer an Ask.",
      },
    ],
  ],
  [
    "Webhooks",
    [
      {
        key: "webhooks.mode",
        value: mono(settings.webhooks),
        effect:
          "Parsed and checked; this version of usine finds GitHub changes by polling alone. A change applies when usine up restarts.",
      },
      ...(settings.webhooksPublicUrl === null
        ? []
        : [
            {
              key: "webhooks.public_url",
              value: mono(settings.webhooksPublicUrl),
              effect: "Where GitHub would deliver webhooks.",
            },
          ]),
    ],
  ],
];

/** The `settings` and `operator` keys of `usine.yaml` and its webhooks mode, defaults applied,
 * each with what its value does. */
export const SettingsPage = ({ configuration }: { readonly configuration: ConfigurationView }) => (
  <ConfigurationPage title="Settings">
    <div className="flex max-w-4xl flex-col gap-8 pt-2">
      {groups(configuration.settings).map(([group, settings]) => (
        <section key={group} className="flex flex-col gap-3">
          <h2 className="text-md font-semibold">{group}</h2>
          <dl className="border-t">
            {settings.map(({ key, value, effect }) => (
              <div
                key={key}
                className="grid gap-x-6 gap-y-1 border-b py-3 sm:grid-cols-[16rem_minmax(0,1fr)]"
              >
                <dt className="font-mono text-xs leading-5 text-muted-foreground">{key}</dt>
                <dd className="flex flex-col gap-0.5 wrap-anywhere">
                  <span>{value}</span>
                  <span className="text-xs text-muted-foreground">{effect}</span>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  </ConfigurationPage>
);

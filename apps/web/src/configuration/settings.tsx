import type { ConfigurationView, SettingsView } from "@usine/orchestrator/operator";
import type { ReactNode } from "react";
import { ConfigurationPage } from "./section.tsx";

interface Setting {
  /** The key as written in `usine.yaml`. */
  readonly key: string;
  readonly value: ReactNode;
  /** A one-sentence description of what the value does. */
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
        effect: "Maximum child sessions per attempt. Starting one more fails the attempt.",
      },
      {
        key: "settings.max_attempt_minutes",
        value:
          settings.maxAttemptMinutes === null ? unset("Not set") : mono(settings.maxAttemptMinutes),
        effect:
          settings.maxAttemptMinutes === null
            ? "No wall-clock ceiling."
            : "Minutes an attempt may run before the runaway guard fails it.",
      },
      {
        key: "settings.max_attempt_tokens",
        value:
          settings.maxAttemptTokens === null ? unset("Not set") : mono(settings.maxAttemptTokens),
        effect:
          settings.maxAttemptTokens === null
            ? "No token ceiling."
            : "Tokens an attempt may use, parent and children combined, before the runaway guard fails it.",
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
            ? "Chosen by Pi unless the agent file sets parent_model."
            : "Parent model when the agent file sets no parent_model.",
      },
      {
        key: "settings.parent_effort",
        value: settings.parentEffort === null ? unset("Not set") : mono(settings.parentEffort),
        effect:
          settings.parentEffort === null
            ? "parent_effort from the agent file, or effort if it is not set."
            : "Parent effort when the agent file sets no parent_effort.",
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
            ? "Approvals from the UI record no approver; messages show as local operator."
            : "The GitHub login recorded on approvals and messages from the UI, and the only login that can answer an ask on GitHub.",
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
          "Parsed and validated but not used: this version reads GitHub changes by polling only. A change applies after usine up restarts.",
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

/** Renders the `settings` and `operator` keys of `usine.yaml` and the webhooks mode, with defaults applied. */
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

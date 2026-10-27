import { CaretRightIcon } from "@phosphor-icons/react";
import { Match, Schema } from "effect";
import { Markdown } from "~/components/markdown";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from "~/components/ai-elements/code-block";
import { Terminal } from "~/components/ai-elements/terminal";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";
import type { ToolPresentation, ToolSection } from "~/lib/runs/transcript/tool/presentation";

const JsonArray = Schema.Array(Schema.Json);

type ValueProps = { readonly value: Schema.Json };

const Value = ({ value }: ValueProps) => {
  if (value === null) return <span className="text-muted-foreground">None</span>;
  if (Schema.is(Schema.String)(value))
    return (
      <span className="block max-h-48 overflow-auto whitespace-pre-wrap wrap-anywhere">
        {value}
      </span>
    );
  if (Schema.is(Schema.Boolean)(value)) return <span>{value ? "Yes" : "No"}</span>;
  if (Schema.is(Schema.Number)(value)) return <span className="font-mono">{value}</span>;
  const entries = Schema.is(JsonArray)(value)
    ? value.map((item, index) => ({ label: `Item ${index + 1}`, value: item }))
    : Object.entries(value).map(([label, value]) => ({ label, value }));
  if (entries.length === 0) return <span className="text-muted-foreground">Empty</span>;
  return (
    <Collapsible>
      <CollapsibleTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="h-auto gap-1 px-0 py-0 text-muted-foreground data-[panel-open]:[&_svg]:rotate-90"
          />
        }
      >
        <CaretRightIcon aria-hidden="true" />
        {entries.length} {entries.length === 1 ? "entry" : "entries"}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 border-l pl-3">
        <Fields fields={entries} />
      </CollapsibleContent>
    </Collapsible>
  );
};

type FieldsProps = {
  readonly fields: Extract<ToolSection, { readonly _tag: "Fields" }>["fields"];
};

const Fields = ({ fields }: FieldsProps) => (
  <dl className="space-y-3 text-xs/relaxed">
    {fields.map(({ label, value }, index) => (
      <div
        className="grid min-w-0 grid-cols-[minmax(5rem,1fr)_minmax(0,3fr)] gap-3"
        key={`${label}:${index}`}
      >
        <dt className="text-muted-foreground wrap-anywhere">{label}</dt>
        <dd className="min-w-0">
          <Value value={value} />
        </dd>
      </div>
    ))}
  </dl>
);

type ToolSectionsProps = {
  readonly sections: ReadonlyArray<ToolSection>;
  readonly category: ToolPresentation["category"];
};

/** Renders tool sections; read results get no added line numbers because their text already has them. */
export const ToolSections = ({ sections, category }: ToolSectionsProps) =>
  sections.map((section, index) => (
    <div key={`${section.label}:${index}`} className="min-w-0">
      {Match.valueTags(section, {
        Code: ({ label, text, language }) =>
          category === "command" && language === "text" ? (
            <Terminal output={text} title={label} />
          ) : (
            <CodeBlock
              code={text}
              language={language}
              showLineNumbers={
                category !== "read" && (language === "typescript" || language === "diff")
              }
            >
              <CodeBlockHeader>
                <CodeBlockTitle className="wrap-anywhere">{label}</CodeBlockTitle>
                <CodeBlockActions>
                  <CodeBlockCopyButton />
                </CodeBlockActions>
              </CodeBlockHeader>
            </CodeBlock>
          ),
        Text: ({ label, text }) => (
          <section aria-label={label}>
            <Markdown>{text}</Markdown>
          </section>
        ),
        Fields: ({ label, fields }) => (
          <section aria-label={label}>
            <Fields fields={fields} />
          </section>
        ),
      })}
    </div>
  ));

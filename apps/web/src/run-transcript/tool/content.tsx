import { CaretRightIcon } from "@phosphor-icons/react";
import { Match, Schema } from "effect";
import { Markdown } from "@/components/markdown";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ai-elements/code-block";
import { Terminal } from "@/components/ai-elements/terminal";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { ToolPresentation, ToolSection } from "./presentation.ts";

const JsonArray = Schema.Array(Schema.Json);

// Unknown tools still expose their values as labeled, expandable content. Only
// the explicit Raw details control renders the transport envelope as JSON.
const Value = ({ value }: { readonly value: Schema.Json }) => {
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

const Fields = ({
  fields,
}: {
  readonly fields: Extract<ToolSection, { readonly _tag: "Fields" }>["fields"];
}) => (
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

/** Renders readable tool content using AI Elements code and terminal surfaces. */
export const ToolSections = ({
  sections,
  category,
}: {
  readonly sections: ReadonlyArray<ToolSection>;
  readonly category: ToolPresentation["category"];
}) =>
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
              showLineNumbers={language === "typescript" || language === "diff"}
            >
              <CodeBlockHeader>
                <CodeBlockTitle>{label}</CodeBlockTitle>
                <CodeBlockActions>
                  <CodeBlockCopyButton />
                </CodeBlockActions>
              </CodeBlockHeader>
            </CodeBlock>
          ),
        Text: ({ label, text }) => (
          <section className="space-y-2">
            <h4 className="font-medium text-muted-foreground">{label}</h4>
            <Markdown>{text}</Markdown>
          </section>
        ),
        Fields: ({ label, fields }) => (
          <section className="space-y-2">
            <h4 className="font-medium text-muted-foreground">{label}</h4>
            <Fields fields={fields} />
          </section>
        ),
      })}
    </div>
  ));

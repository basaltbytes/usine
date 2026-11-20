import { ItemNumber } from "@usine/core/item";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { Option, Schema } from "effect";

const LineNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** A task, run, source line, or name that usine text writes, before usine's data is read. */
export const Reference = Schema.Union([
  /** `#<number>`, or `<owner>/<name>#<number>`. */
  Schema.TaggedStruct("Task", { repository: Schema.NullOr(RepositoryName), number: ItemNumber }),
  /** A run ID, in text or a code span: 32 lowercase hex digits. */
  Schema.TaggedStruct("Run", { run: RunId }),
  /** `<path>:<line>` or `<path>:<line>-<end>` in a code span. */
  Schema.TaggedStruct("Source", {
    path: Schema.NonEmptyString,
    line: LineNumber,
    end: Schema.NullOr(LineNumber),
  }),
  /** Any other single-line code span, such as a loop, agent, worker, or label name. */
  Schema.TaggedStruct("Name", { name: Schema.NonEmptyString }),
]);
export type Reference = typeof Reference.Type;

/** Where a reference is written: in a heading, a table cell, or other text. */
export const ReferencePlace = Schema.Literals(["heading", "cell", "text"]);
export type ReferencePlace = typeof ReferencePlace.Type;

/** A reference as the Markdown tree carries it, whether it was a code span, and where it is. */
const ReferenceMark = Schema.fromJsonString(
  Schema.Struct({ reference: Reference, code: Schema.Boolean, place: ReferencePlace }),
);
const encodeMark = Schema.encodeSync(ReferenceMark);

/** Returns the reference that `value`, the attribute of a reference element, carries. */
export const decodeReferenceMark = Schema.decodeUnknownOption(ReferenceMark);

const REPOSITORY = String.raw`[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+`;
const NUMBER = String.raw`[1-9]\d{0,8}`;
const RUN = String.raw`[0-9a-f]{32}`;
/** A task or a run ID that isn't part of a longer word, path, or ID. */
const IN_TEXT = new RegExp(
  String.raw`(?<![\w/#&.-])(?:(?:(?<repository>${REPOSITORY}))?#(?<number>${NUMBER})(?![\w-])|(?<run>${RUN})(?![\w-]))`,
  "gu",
);
const TASK = new RegExp(String.raw`^(?:(?<repository>${REPOSITORY}))?#(?<number>${NUMBER})$`, "u");
const RUN_ID = new RegExp(`^${RUN}$`, "u");
const SOURCE = new RegExp(
  String.raw`^(?<path>[^\s:]*/[^\s:]+):(?<line>${NUMBER})(?:-(?<end>${NUMBER}))?$`,
  "u",
);
const NAME = /^[\p{L}\p{N}][\p{L}\p{N}_.:/@ -]{0,99}$/u;

const taskOf = (repository: string | undefined, number: string): Reference => ({
  _tag: "Task",
  repository: repository === undefined ? null : RepositoryName.make(repository),
  number: ItemNumber.make(Number(number)),
});

/** A part of prose: plain text, or the text that writes a reference. */
export type ProsePart =
  | { readonly _tag: "Text"; readonly text: string }
  | { readonly _tag: "Reference"; readonly text: string; readonly reference: Reference };

/** Returns `text` split into its plain text and the tasks and run IDs it writes, in order. */
export const textReferences = (text: string): ReadonlyArray<ProsePart> => {
  const parts: Array<ProsePart> = [];
  let last = 0;
  for (const match of text.matchAll(IN_TEXT)) {
    const { repository, number, run } = match.groups ?? {};
    if (match.index > last) parts.push({ _tag: "Text", text: text.slice(last, match.index) });
    parts.push({
      _tag: "Reference",
      text: match[0],
      reference:
        run === undefined
          ? taskOf(repository, number ?? "")
          : { _tag: "Run", run: RunId.make(run) },
    });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ _tag: "Text", text: text.slice(last) });
  return parts;
};

/** Returns the reference that a code span with `code` writes, if it can be one. */
export const codeReference = (code: string): Option.Option<Reference> => {
  const value = code.trim();
  const task = TASK.exec(value)?.groups;
  if (task !== undefined) return Option.some(taskOf(task["repository"], task["number"] ?? ""));
  if (RUN_ID.test(value)) return Option.some({ _tag: "Run", run: RunId.make(value) });
  const source = SOURCE.exec(value)?.groups;
  if (source !== undefined) {
    const line = Number(source["line"]);
    const end = source["end"] === undefined ? null : Number(source["end"]);
    return Option.some({
      _tag: "Source",
      path: source["path"] ?? value,
      line,
      end: end !== null && end > line ? end : null,
    });
  }
  return NAME.test(value) ? Option.some({ _tag: "Name", name: value }) : Option.none();
};

/** Subset of a Markdown syntax tree node that the reference marks read and write. */
interface MarkdownNode {
  readonly type: string;
  readonly value?: string;
  children?: Array<MarkdownNode>;
  readonly data?: {
    readonly hName: string;
    readonly hProperties: { readonly value: string };
  };
}

/** The element that carries a reference to the `Markdown` components: HTML's machine-readable value. */
export const REFERENCE_ELEMENT = "data";

const marked = (
  type: "text" | "inlineCode",
  value: string,
  reference: Reference,
  place: ReferencePlace,
): MarkdownNode => ({
  type,
  value,
  data: {
    hName: REFERENCE_ELEMENT,
    hProperties: { value: encodeMark({ reference, code: type === "inlineCode", place }) },
  },
});

// Text inside a link is already a link, and code blocks and raw HTML stay as written.
const UNMARKED = new Set(["link", "linkReference", "code", "html", "definition"]);

const placeOf = (node: MarkdownNode, around: ReferencePlace): ReferencePlace =>
  node.type === "heading" ? "heading" : node.type === "tableCell" ? "cell" : around;

const markReferences = (node: MarkdownNode, place: ReferencePlace): void => {
  if (node.children === undefined) return;
  node.children = node.children.flatMap((child): ReadonlyArray<MarkdownNode> => {
    if (child.type === "text")
      return textReferences(child.value ?? "").map((part) =>
        part._tag === "Text"
          ? { type: "text", value: part.text }
          : marked("text", part.text, part.reference, place),
      );
    if (child.type === "inlineCode")
      return [
        Option.match(codeReference(child.value ?? ""), {
          onNone: () => child,
          onSome: (reference) => marked("inlineCode", child.value ?? "", reference, place),
        }),
      ];
    if (!UNMARKED.has(child.type)) markReferences(child, placeOf(child, place));
    return [child];
  });
};

/**
 * Marks the tasks and run IDs in prose, and the code spans that can be a reference, as `data`
 * elements whose `value` is their `ReferenceMark`. Code blocks, raw HTML, and link text stay as
 * written.
 */
export const remarkReferences = () => (tree: MarkdownNode) => markReferences(tree, "text");

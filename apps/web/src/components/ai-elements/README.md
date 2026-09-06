# AI Elements

Tool, CodeBlock, Terminal and the shared clipboard control are adapted from
[Vercel AI Elements](https://github.com/vercel/ai-elements/tree/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src)
at commit `6a9d5b1822ffb10bba4bd97175f01edd7d8651cd`. The upstream Apache 2.0
copyright and license notice is retained in [LICENSE](LICENSE).

Source files: [tool.tsx](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/tool.tsx),
[code-block.tsx](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/code-block.tsx),
and [terminal.tsx](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/terminal.tsx).

These files retain the upstream collapsible tool composition, source panel and
clipboard composition, and ANSI terminal rendering. Local adaptations use Base UI
primitives, Phosphor icons, the usine theme, and the statuses the Run transcript
actually records. Tool content is supplied by the caller; the upstream automatic
JSON renderers and AI SDK types are omitted.

Tool uses a flat disclosure row with a subtle header background while hovered or
expanded. The background extends 8px beyond the text column; transcript row wrappers
reserve that space inside MessageScroller's paint containment. Expanded content
aligns with the header text through indentation. CodeBlock and Terminal retain their
own bordered surfaces.

CodeBlock retains source text immediately while Shiki loads the selected grammar.
Only bash, diff, TypeScript and JSON grammars are imported; plain text needs no
highlighter. A CSS-variable theme uses the existing theme tokens. Each mounted
panel owns its highlighting result and disposes its highlighter after tokenizing.
This replaces the upstream global token cache, whose abbreviated source keys can
collide when two equally sized files differ only in the middle, and avoids retaining
every historical tool result. Async results apply only to the exact source and
language requested. Highlighting and clipboard failures remain visible to the reader.

`ansi-to-react` 6.2.6 publishes a CommonJS `exports.default` entry. The small
`ansi.cjs` bridge selects that declared export before ESM import, avoiding Vite 8's
different interpretation of a CommonJS default import. Vite prebundles this local
bridge for development; production builds bundle it normally.

Language selectors, approval controls, terminal clearing and terminal live scrolling
are omitted: these panels display recorded tool activity, while MessageScroller
owns the conversation's scroll behavior.

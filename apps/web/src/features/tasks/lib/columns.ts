// Column visibility uses container queries on the table width, because the sidebar can leave less
// room than the viewport suggests. Elapsed time is always shown; Tokens and Estimated cost need
// 56rem, Runs and Pull request 64rem.
export const WIDE_COLUMN = "hidden @5xl:table-cell";
export const USAGE_COLUMN = "hidden @4xl:table-cell";
export const SIDE_CONTENT = "@md:w-max @md:max-w-(--side)";

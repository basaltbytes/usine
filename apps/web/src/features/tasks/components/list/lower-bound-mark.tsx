/** Renders the `*` after a lower-bound figure, past the figure's end so the column stays aligned;
 * the parent must be positioned. */
export const LowerBoundMark = () => (
  <span className="absolute left-full text-muted-foreground">*</span>
);

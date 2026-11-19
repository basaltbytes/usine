const reactRules = new Set(["usine/no-manual-memo", "usine/no-unreasoned-effect"]);

export const invalidReactDisable = (comment: string): boolean => {
  const directive = /^\s*(?:oxlint|eslint)-disable(-next-line|-line)?(?:\s|$)([\s\S]*)/u.exec(
    comment,
  );
  if (directive === null) return false;
  const [rules = "", ...reason] = (directive[2] ?? "").split(/(?:^|\s)--(?:\s|$)/u);
  const names = rules
    .trim()
    .split(/[\s,]+/u)
    .filter(Boolean);
  if (names.length === 0 || names.includes("usine/require-react-disable-reason")) return true;
  if (!names.some((name) => reactRules.has(name))) return false;
  return directive[1] !== "-next-line" || reason.join(" ").trim() === "";
};

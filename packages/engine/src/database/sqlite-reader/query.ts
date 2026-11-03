// Quoted text and comments cannot affect the top-level verb of a CTE.
const tokens =
  /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[(),]|[a-z_][a-z_0-9]*/giu;

export const isReadQuery = (sql: string): boolean => {
  let first = true;
  let depth = 0;
  let body = false;
  let afterBody = false;
  for (const [token] of sql.matchAll(tokens)) {
    if (token.startsWith("--") || token.startsWith("/*")) continue;
    const keyword = token.toUpperCase();
    if (first) {
      if (keyword === "SELECT") return true;
      if (keyword !== "WITH") return false;
      first = false;
      continue;
    }
    if (afterBody) {
      if (token !== ",") return keyword === "SELECT";
      body = false;
      afterBody = false;
    } else if (token === "(") depth++;
    else if (token === ")") {
      depth--;
      afterBody = depth === 0 && body;
    } else if (depth === 0 && keyword === "AS") body = true;
  }
  return false;
};

// Stands in for ssh: records its arguments and environment to $RECORD_TO, then exits.
import { writeFileSync } from "node:fs";

writeFileSync(
  process.env.RECORD_TO,
  JSON.stringify({ argv: process.argv.slice(2), env: process.env }),
);

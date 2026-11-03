import { attemptRecordsContract } from "./attempt-records.ts";
import { attentionContract } from "./attention.ts";
import { boardMovesContract } from "./board-moves.ts";
import { cursorContract } from "./cursor.ts";
import { cycleBudgetContract } from "./cycle-budget.ts";
import { itemProjectionContract } from "./item-projection.ts";
import { loopControlContract } from "./loop-control.ts";
import { repositoryLabelProjectionContract } from "./repository-label-projection.ts";
import { runReaderContract } from "./run-reader.ts";
import { runStoreContract } from "./run-store.ts";
import { sqliteAdapter } from "./sqlite.ts";
import { transcriptContract } from "./transcript.ts";

for (const adapter of [sqliteAdapter]) {
  attentionContract(adapter);
  attemptRecordsContract(adapter);
  boardMovesContract(adapter);
  cycleBudgetContract(adapter);
  cursorContract(adapter);
  itemProjectionContract(adapter);
  loopControlContract(adapter);
  repositoryLabelProjectionContract(adapter);
  runReaderContract(adapter);
  runStoreContract(adapter);
  transcriptContract(adapter);
}

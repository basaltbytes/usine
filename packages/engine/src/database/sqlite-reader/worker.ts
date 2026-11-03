import { Effect, Option, Ref, Schema } from "effect";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { isReadQuery } from "./query.ts";
import { Params, Request, type Response } from "./protocol.ts";

const { filename } = Schema.decodeUnknownSync(Schema.Struct({ filename: Schema.String }))(
  workerData,
);
const db = new DatabaseSync(filename, { readOnly: true });
db.exec("PRAGMA busy_timeout = 5000");
const Diagnostic = Schema.Struct({
  message: Schema.String,
  errcode: Schema.optionalKey(Schema.Finite),
});
const session = Ref.makeUnsafe<number | null>(null);
const statements = new Map<string, StatementSync>();
const port = parentPort;
if (port === null) throw new Error("SQLite reader requires a worker message port");

port.on("message", (message) => {
  const request = Schema.decodeUnknownSync(Request)(message);
  let response: Response;
  try {
    const command = request.command;
    if (command._tag === "BeginSnapshot") {
      if (Ref.getUnsafe(session) !== null) throw new Error("SQLite snapshot already open");
      db.exec("BEGIN");
      // The snapshot starts at the first read, including an empty database.
      db.prepare("SELECT count(*) FROM sqlite_schema").get();
      Effect.runSync(Ref.set(session, request.id));
      response = { id: request.id, ok: true, result: request.id };
    } else if (command._tag === "EndSnapshot") {
      if (Ref.getUnsafe(session) !== command.session)
        throw new Error("SQLite snapshot session mismatch");
      db.exec(command.commit ? "COMMIT" : "ROLLBACK");
      Effect.runSync(Ref.set(session, null));
      response = { id: request.id, ok: true, result: null };
    } else {
      if (Ref.getUnsafe(session) !== command.session)
        throw new Error("SQLite snapshot session mismatch");
      if (!isReadQuery(command.sql))
        throw new Error("SQLite read worker requires a read-only statement");
      let statement = statements.get(command.sql);
      if (statement === undefined) {
        statement = db.prepare(command.sql);
        statements.set(command.sql, statement);
        if (statements.size > 200) {
          const oldest = statements.keys().next();
          if (!oldest.done) statements.delete(oldest.value);
        }
      }
      statement.setReadBigInts(command.safeIntegers);
      statement.setReturnArrays(command.values);
      response = {
        id: request.id,
        ok: true,
        result: statement.all(...Schema.decodeUnknownSync(Params)(command.params)),
      };
    }
  } catch (cause) {
    response = {
      id: request.id,
      ok: false,
      cause: Option.match(Schema.decodeUnknownOption(Diagnostic)(cause), {
        onNone: () => ({ message: "SQLite read failed" }),
        onSome: ({ message, errcode }) =>
          errcode === undefined ? { message } : { message, errno: errcode },
      }),
    };
  }
  port.postMessage(response);
});

import { Option, Schema } from "effect";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { Params, Request, type Response } from "./protocol.ts";

const { filename } = Schema.decodeUnknownSync(Schema.Struct({ filename: Schema.String }))(
  workerData,
);
const db = new DatabaseSync(filename, { readOnly: true });
db.exec("PRAGMA busy_timeout = 5000");
const Diagnostic = Schema.Struct({
  message: Schema.String,
  errcode: Schema.optionalKey(Schema.Number),
});
const statements = new Map<string, StatementSync>();
const port = parentPort;
if (port === null) throw new Error("SQLite reader requires a worker message port");

port.on("message", (message) => {
  const request = Schema.decodeUnknownSync(Request)(message);
  let response: Response;
  try {
    let statement = statements.get(request.sql);
    if (statement === undefined) {
      statement = db.prepare(request.sql);
      statements.set(request.sql, statement);
      if (statements.size > 200) {
        const oldest = statements.keys().next();
        if (!oldest.done) statements.delete(oldest.value);
      }
    }
    statement.setReadBigInts(request.safeIntegers);
    statement.setReturnArrays(request.values);
    response = {
      id: request.id,
      ok: true,
      result: statement.all(...Schema.decodeUnknownSync(Params)(request.params)),
    };
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

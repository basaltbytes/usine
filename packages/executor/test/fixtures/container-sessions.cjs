#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const [operation, ...args] = process.argv.slice(2);
const root = process.env.USINE_TEST_CONTAINERS;

switch (operation) {
  case "rm":
    fs.rmSync(path.join(root, args.at(-1)), { recursive: true, force: true });
    break;
  case "run": {
    const name = args[args.indexOf("--name") + 1];
    const home = path.join(root, name);
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    for (const [index, argument] of args.entries()) {
      if (args[index - 1] !== "--mount") continue;
      const fields = Object.fromEntries(
        argument.split(",").map((field) => field.replaceAll('"', "").split("=")),
      );
      if (fields.destination === "/home/usine/.claude/projects")
        fs.symlinkSync(fields.source, path.join(home, ".claude", "projects"));
    }
    fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
    process.stdout.write("container-id\n");
    break;
  }
  case "exec": {
    const [, name, command, ...commandArgs] = args;
    const result = spawnSync(command, commandArgs, {
      env: { ...process.env, HOME: path.join(root, name) },
      stdio: "inherit",
    });
    process.exit(result.status ?? 1);
  }
  default:
    throw new Error(`Unsupported container operation: ${operation}`);
}

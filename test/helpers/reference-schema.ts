import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Empty-DB reference schema; the fork DDL requires tables from the base file. */
export function readReferenceSchema(root = resolve(import.meta.dirname, "../..")): string {
  return ["schema.sql", "fork-write-protection.sql"]
    .map(name => readFileSync(resolve(root, "db", name), "utf8"))
    .join("\n");
}

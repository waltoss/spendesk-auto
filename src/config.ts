// Load config/rules.ts and refuse to go on if it is malformed.
//
// Importing it from every module would spread the "is this file even valid?" question
// across the codebase. It is asked once, here, at import time — before a single request is
// made, let alone a write.
//
// The failure is deliberately a plain message and exit 1, not a stack trace: the person
// most likely to see it is the person who just added a supplier, and a stack trace tells
// them nothing they can act on.
import { me as rawMe, defaults as rawDefaults, rules as rawRules } from "../config/rules.ts";
import { parseRulesFile } from "./schemas/rules.ts";
import type { RulesFile } from "./types.ts";

let file: RulesFile;
try {
  file = parseRulesFile({ me: rawMe, defaults: rawDefaults, rules: rawRules });
} catch (e) {
  console.error(`\n  ✗ ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}

export const me = file.me;
export const defaults = file.defaults;
export const rules = file.rules;

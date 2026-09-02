// Turn the labels in config/rules.ts into the ids the API wants.
//
// This module is what makes the rules file safe for a non-programmer to edit: every label
// is resolved against the live schema before anything is written, so a typo or a renamed
// dropdown value fails loudly with the list of valid alternatives.
import { err, ok, type Result, type Rule } from "../types.ts";
import { AnalyticalField, AnalyticalValue, User } from "../schemas/spendesk.ts";
import { publicApiAll } from "./auth.ts";

/** Field names carry stray trailing spaces in Spendesk ("A refacturer au client ? "). */
const norm = (s: string | null | undefined): string => (s ?? "").trim().replace(/\s+/g, " ");

export interface SchemaField {
  id: string;
  name: string;
  /** label -> value id */
  values: Map<string, string>;
}

export interface ResolvedValue {
  fieldId: string;
  fieldName: string;
  valueId: string;
  valueName: string;
}

export interface LiveSchema {
  fields: Map<string, SchemaField>;
  fieldById: Map<string, SchemaField>;
  /** The completions oracle reports missing fields by id, so the map works both ways. */
  labelFor: (fieldId: string) => string;
  resolveField: (label: string) => SchemaField | null;
  resolveValue: (label: string, value: string) => Result<ResolvedValue>;
}

export async function loadSchema(): Promise<LiveSchema> {
  const fields = await publicApiAll(AnalyticalField, "/v1/analytical-fields");
  const byName = new Map<string, SchemaField>();

  for (const f of fields) {
    // /v1/analytical-fields/{id}/values caps pageSize at 30, and the label key is
    // "value", not "name" (DESIGN §8.6).
    const values = await publicApiAll(AnalyticalValue, `/v1/analytical-fields/${f.id}/values`);
    byName.set(norm(f.name), {
      id: f.id,
      name: norm(f.name),
      values: new Map(values.map((v) => [norm(v.value), v.id])),
    });
  }

  const fieldById = new Map([...byName.values()].map((f) => [f.id, f] as const));
  const labelFor = (fieldId: string): string => fieldById.get(fieldId)?.name ?? fieldId;

  const resolveField = (label: string): SchemaField | null => {
    const want = norm(label);
    return byName.get(want) ?? [...byName.values()].find((f) => f.name.startsWith(want)) ?? null;
  };

  const resolveValue = (label: string, value: string): Result<ResolvedValue> => {
    const field = resolveField(label);
    if (!field) return err(`unknown field "${label}" — valid: ${[...byName.keys()].join(", ")}`);
    const valueId = field.values.get(norm(value));
    if (!valueId)
      return err(`field "${field.name}" has no value "${value}" — valid: ${[...field.values.keys()].join(", ")}`);
    return ok({ fieldId: field.id, fieldName: field.name, valueId, valueName: norm(value) });
  };

  return { fields: byName, fieldById, labelFor, resolveField, resolveValue };
}

export interface Member {
  id: string;
  name: string;
  email: string;
}

/** memberId from an email. Never hardcode an id; Theodo has >30 users, so paginate. */
export async function resolveMember(email: string): Promise<Member> {
  const users = await publicApiAll(User, "/v1/users");
  const user = users.find((u) => (u.email ?? "").toLowerCase() === email.toLowerCase());
  if (!user) throw new Error(`no Spendesk user matches ${email} (searched ${users.length} users)`);
  return { id: user.id, name: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim(), email: user.email ?? email };
}

/**
 * Resolve every label in config/rules.ts. Returns the problems; empty means valid.
 * Run by `rules:check`, and again at the top of every real run.
 */
export function validateRules({
  schema,
  defaults,
  rules,
}: {
  schema: LiveSchema;
  defaults: Record<string, string>;
  rules: Rule[];
}): string[] {
  const problems: string[] = [];
  const check = (label: string, value: string, where: string): void => {
    const r = schema.resolveValue(label, value);
    if (!r.ok) problems.push(`${where}: ${r.error}`);
  };

  for (const [label, value] of Object.entries(defaults)) check(label, value, "defaults");

  for (const rule of rules) {
    for (const [label, value] of Object.entries(rule.fields ?? {})) check(label, value, `rule "${rule.name}"`);
    for (const [label, options] of Object.entries(rule.ask?.derive ?? {}))
      for (const value of Object.keys(options)) check(label, value, `rule "${rule.name}" (ask)`);
  }
  return problems;
}

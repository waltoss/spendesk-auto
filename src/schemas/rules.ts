// The shape of config/rules.ts, checked before anything uses it.
//
// That file is edited by whoever notices a new supplier, not necessarily by a programmer,
// so it gets two independent safety nets:
//
//   1. this schema        a structural typo — `suplier:` for `supplier:`, a regex where a
//                         string belongs — fails here. `.strict()` is the point: an
//                         unknown key in a `when` clause would otherwise be ignored, and
//                         a `when` clause that ignores its only condition matches
//                         everything.
//   2. spendesk/schema.ts every label ("Catégorie de dépense" -> "IT Costs") is resolved
//                         against the live Spendesk schema, so a renamed dropdown value
//                         fails with the list of valid alternatives.
//
// Both are loud and both run before the first write.
import { z } from "zod";
import type { DescriptionFn, Rule, RulesFile } from "../types.ts";

const Pattern = z.instanceof(RegExp, { error: "must be a regular expression, like /^cursor$/i" });

const Label = z.string().min(1);

export const RuleWhenSchema = z
  .strictObject({
    supplier: Pattern.optional(),
    description: Pattern.optional(),
    currency: z.string().length(3).optional(),
    amount: z.number().optional(),
    gcpAccount: z.string().optional(),
  })
  .refine((w) => Object.keys(w).length > 0, {
    error: 'an empty "when" would match every payment — remove it or give it a condition',
  });

export const RuleAskSchema = z.strictObject({
  question: z.string().min(1),
  derive: z.record(Label, z.record(Label, Pattern)).optional(),
});

export const RuleSchema = z
  .strictObject({
    name: z.string().min(1),
    when: RuleWhenSchema.optional(),
    fields: z.record(Label, z.string().min(1)).optional(),
    description: z
      .union([
        z.string().min(1),
        z.custom<DescriptionFn>((v) => typeof v === "function", {
          error: "must be a string or a function of ({ month, amount, currency, date, supplier })",
        }),
      ])
      .optional(),
    invoice: z.enum(["cursor", "gcp"]).optional(),
    ask: RuleAskSchema.optional(),
  })
  .check((ctx) => {
    const rule = ctx.value;
    if (!rule.fields && !rule.ask)
      ctx.issues.push({
        code: "custom",
        input: rule,
        message: `rule "${rule.name}" does nothing: give it "fields" to write, or "ask" to escalate`,
      });
    if (rule.fields && rule.ask)
      ctx.issues.push({
        code: "custom",
        input: rule,
        message: `rule "${rule.name}" both writes fields and asks a question — pick one`,
      });
  });

export const RulesFileSchema = z.strictObject({
  me: z.strictObject({ email: z.email() }),
  defaults: z.record(Label, z.string().min(1)),
  rules: z.array(RuleSchema).min(1),
});

/**
 * Validate the config file's structure. Throws with every problem at once, because
 * fixing one typo only to be told about the next is how people stop reading the output.
 */
export function parseRulesFile(input: unknown): RulesFile {
  const result = RulesFileSchema.safeParse(input);
  if (result.success) return result.data as RulesFile;
  throw new Error(`config/rules.ts is not valid:\n${z.prettifyError(result.error)}`);
}

/** Named separately so tests can exercise one rule without a whole file. */
export function parseRule(input: unknown): Rule {
  return RuleSchema.parse(input) as Rule;
}

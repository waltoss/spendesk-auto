// Resolve config/rules.mjs against the live Spendesk schema. Exit 1 on any unknown label.
// This is what makes the rules file safe to edit: a typo fails here, not in production.
import fs from "node:fs";
import path from "node:path";
import { rules, defaults, me } from "../config/rules.mjs";

const API = "https://public-api.spendesk.com";
const ROOT = process.cwd();

const creds = fs.readFileSync(path.resolve(ROOT, ".spendesk-api"), "utf8");
const id = /^ID=(.*)$/im.exec(creds)?.[1].trim();
const secret = /^Secret=(.*)$/im.exec(creds)?.[1].trim();
const basic = Buffer.from(`${id}:${secret}`).toString("base64");

const { access_token } = await (await fetch(`${API}/v1/auth/token`, {
  method: "POST", headers: { authorization: `Basic ${basic}` },
})).json();
const api = async (p) => (await fetch(`${API}${p}`, { headers: { authorization: `Bearer ${access_token}` } })).json();

// ---- pull the live schema: field names -> value names -> ids
const fieldsRes = await api("/v1/analytical-fields?page=1&pageSize=30");
const fields = fieldsRes.data ?? fieldsRes;
const schema = new Map();
for (const f of fields) {
  const vals = new Map();
  for (let page = 1; page <= 5; page++) {
    const r = await api(`/v1/analytical-fields/${f.id}/values?page=${page}&pageSize=30`);
    const items = r.data ?? [];
    items.forEach((v) => vals.set(v.value, v.id));
    if (items.length < 30) break;
  }
  schema.set(f.name.trim(), { id: f.id, values: vals });
}

// ---- resolve the member id from the email (paginate: Theodo has >30 users)
let user = null;
for (let page = 1; page <= 40 && !user; page++) {
  const r = await api(`/v1/users?page=${page}&pageSize=30`);
  const items = r.data ?? [];
  user = items.find((u) => (u.email || "").toLowerCase() === me.email.toLowerCase()) || null;
  if (items.length < 30) break;
}

const problems = [];
const resolveField = (label) => {
  const key = [...schema.keys()].find((k) => k === label.trim() || k.startsWith(label.trim()));
  if (!key) { problems.push(`unknown field: "${label}"`); return null; }
  return { key, ...schema.get(key) };
};
const resolveValue = (label, value) => {
  const f = resolveField(label);
  if (!f) return null;
  const vid = f.values.get(value);
  if (!vid) {
    problems.push(`field "${f.key}" has no value "${value}" — valid: ${[...f.values.keys()].join(", ")}`);
    return null;
  }
  return { fieldId: f.id, valueId: vid };
};

console.log(`member : ${user ? `${user.firstName} ${user.lastName} (${user.id})` : `NOT FOUND for ${me.email}`}`);
if (!user) problems.push(`no Spendesk user matches ${me.email}`);
console.log(`schema : ${schema.size} analytical fields\n`);

console.log("defaults");
for (const [k, v] of Object.entries(defaults)) {
  const r = resolveValue(k, v);
  console.log(`   ${r ? "✓" : "✗"} ${k.slice(0, 52)} = ${v}${r ? `  → ${r.fieldId}/${r.valueId}` : ""}`);
}

console.log("\nrules");
for (const rule of rules) {
  const bits = [];
  for (const [k, v] of Object.entries(rule.fields ?? {})) {
    const r = resolveValue(k, v);
    bits.push(`${r ? "✓" : "✗"} ${k.split(")").pop().trim().slice(0, 24)}=${v}`);
  }
  if (rule.ask) {
    for (const [field, opts] of Object.entries(rule.ask.derive ?? {}))
      for (const value of Object.keys(opts)) {
        const r = resolveValue(field, value);
        if (!r) bits.push(`✗ ask ${field}=${value}`);
      }
    bits.push(`↳ asks: "${rule.ask.question}"`);
  }
  console.log(`   ${rule.name.padEnd(30)} ${bits.join("  ")}`);
}

console.log();
if (problems.length) {
  console.log(`${problems.length} problem(s):`);
  problems.forEach((p) => console.log(`   ✗ ${p}`));
  process.exit(1);
}
console.log("all rules resolve against the live Spendesk schema ✓");

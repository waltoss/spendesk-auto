// The only file you should need to touch when a new supplier or rule appears.
//
// Everything is written in the labels you see in Spendesk — "IT Costs", "Non" — never in
// opaque ids. They are checked twice before anything is written: the shape of this file
// is validated on load, and every label is resolved against the live Spendesk API, so a
// typo or a renamed dropdown value fails loudly with the valid alternatives.
//
//   bun run rules:check     validate this file against Spendesk
//
// Matching is first-rule-wins, top to bottom. Anything unmatched is escalated, never guessed.
//
// The one line of TypeScript below is worth its keep: your editor will then complete the
// field names and tell you immediately if you write `suplier:` or `invoice: "gcpp"`.
import type { Rule } from "../src/types.ts";

export const me = { email: "thomas.walter@theodo.com" }; // memberId resolved via /v1/users

export const defaults: Record<string, string> = {
  "1) Cette dépense concerne-t-elle votre budget confort ?": "Non",
  "2) A refacturer au client ?": "Non",
};

export const rules: Rule[] = [
  // ---------------------------------------------------------------- SaaS, fully automatic
  {
    name: "Cursor",
    when: { supplier: /^cursor$/i },
    fields: { "Catégorie de dépense": "IT Costs" },
    description: ({ month }) => `Cursor — abonnement IA ${month}`,
    invoice: "cursor",
  },
  {
    name: "Anthropic / Claude",
    when: { supplier: /^(anthropic|claude)$/i },
    fields: { "Catégorie de dépense": "IT Costs" },
    description: ({ month }) => `Claude — abonnement IA ${month}`,
  },
  {
    name: "OpenAI",
    when: { supplier: /^openai$/i },
    fields: { "Catégorie de dépense": "IT Costs" },
    description: ({ month }) => `OpenAI — abonnement IA ${month}`,
  },
  {
    name: "ElevenLabs",
    when: { supplier: /elevenlabs|fournisseurs divers/i, currency: "USD", amount: 22 },
    fields: { "Catégorie de dépense": "IT Costs" },
    description: ({ month }) => `ElevenLabs — abonnement IA ${month}`,
  },

  // ------------------------------------------------- GCP: one rule per billing account
  // The billing account is identified from the "Paiement reçu" email's payments-profile id,
  // or from the amount matched against payments.google.com.
  {
    name: "GCP — Radical Academy",
    when: { supplier: /google cloud/i, gcpAccount: "012512-2A6C67-A63A08" },
    fields: { "Catégorie de dépense": "Training" },
    description: ({ month }) => `Google Cloud — Radical Academy ${month}`,
    invoice: "gcp",
  },
  {
    name: "GCP — Budget IA / LLM Gateway",
    when: { supplier: /google cloud/i, gcpAccount: "0161AF-0347D6-59B14E" },
    fields: { "Catégorie de dépense": "IT Costs" },
    description: ({ month }) => `Google Cloud — Cost of Hosting for LLM Gateway ${month}`,
    invoice: "gcp",
  },
  {
    name: "GCP — third account",
    when: { supplier: /google cloud/i, gcpAccount: "01AFB6-D85F09-FCD896" },
    fields: { "Catégorie de dépense": "IT Costs" },
    description: ({ month }) => `Google Cloud ${month}`,
    invoice: "gcp",
  },

  // -------------------------------------------------------- meals: ask, never guess
  // The category depends on who was there and why, which is nowhere in the transaction.
  // One reply gives both the category and the description.
  {
    name: "Meals, taxis, hotels",
    when: { supplier: /restaurant|taxi|campanile|auchan|pub |hotel|brasserie/i },
    ask: {
      question: "Who was this meal with, and why?",
      derive: {
        "Catégorie de dépense": {
          Sales: /client|prospect|networking/i,
          Project: /projet|mission|offsite|équipe client/i,
          Training: /academy|bootcamp|formation/i,
          People: /collègue|équipe interne|team|gouter|déjeuner d'équipe/i,
          Directors: /partner|associé|director/i,
        },
        "2) A refacturer au client ?": { Oui: /refactur|à la charge du client/i },
      },
    },
  },
];

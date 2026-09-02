// The guards of DESIGN §9. The API credential is company-wide and PATCH replaces
// lineItems wholesale, so these are the only thing standing between a bug and someone
// else's €50k subcontracting invoice.
import { expect, test } from "bun:test";
import { buildPatch, GuardError } from "../src/spendesk/write.ts";
import { blank, filled, MEMBER_ID, IT_COSTS } from "./fixtures/payables.ts";

const ok = { memberId: MEMBER_ID, expectedSearchState: "toPrepare" };

/** Assert both that a guard tripped and that it said which one — the message is the fix. */
function expectGuard(fn: () => unknown, message: RegExp): void {
  let thrown: unknown;
  let threw = false;
  try {
    fn();
  } catch (e) {
    thrown = e;
    threw = true;
  }
  expect(threw).toBe(true);
  expect(thrown).toBeInstanceOf(GuardError);
  expect((thrown as Error).message).toMatch(message);
}

test("refuses a payable belonging to someone else", () => {
  expectGuard(() => buildPatch({ ...blank, userId: "someone-else" }, [IT_COSTS], ok), /belongs to someone-else/);
});

test("refuses anything that is not toPrepare", () => {
  for (const state of ["toExport", "exported", undefined]) {
    expectGuard(
      () => buildPatch(blank, [IT_COSTS], { ...ok, expectedSearchState: state }),
      /refusing to touch anything but toPrepare/,
    );
  }
});

test("refuses an already-exported payable even if search called it toPrepare", () => {
  expectGuard(
    () => buildPatch({ ...blank, exportedAt: "2026-08-01T00:00:00.000Z" }, [IT_COSTS], ok),
    /was exported at/,
  );
});

test("refuses to write when the line items no longer sum to the payable", () => {
  const tampered = { ...blank, amount: 9999 };
  expectGuard(() => buildPatch(tampered, [IT_COSTS], ok), /sum to 1708 but payable is 9999/);
});

test("sends the version it read, for optimistic concurrency", () => {
  expect(buildPatch(blank, [IT_COSTS], ok).version).toBe(2);
  expect(buildPatch(filled, [IT_COSTS], ok).version).toBe(5);
});

test("fills a blank payable without inventing anything", () => {
  const body = buildPatch(blank, [IT_COSTS], ok);
  expect(body.lineItems.length).toBe(1);
  const li = body.lineItems[0]!;
  expect(li.grossAmount).toBe(1708);
  // a missing tax account is preserved as null, not dropped
  expect(li.taxAccountId).toBe(null);
  expect(li.costCenterId).toBe("523175aa-3bea-47e2-839c-4b217c301c7e");
  expect(li.analyticalFieldValues).toEqual([IT_COSTS]);
});

test("correcting one field preserves the other two", () => {
  const body = buildPatch(filled, [IT_COSTS], ok);
  const values = body.lineItems[0]!.analyticalFieldValues;

  expect(values.length).toBe(3); // three fields in, three fields out
  expect(values.find((v) => v.fieldId === IT_COSTS.fieldId)).toEqual(IT_COSTS); // the category is replaced

  for (const untouched of ["0ih_9b1mfr0mzs", "qrabw6on0c4jha"]) {
    const before = filled.lineItems[0]!.analyticalProperties.find((a) => a.fieldId === untouched);
    expect(values.find((v) => v.fieldId === untouched)).toEqual({
      fieldId: before!.fieldId!,
      valueId: before!.valueId!,
    });
  }
});

test("never carries the cost centre over as an analytical value", () => {
  // costCenter arrives in the same analyticalFieldAssociations array as the custom fields
  // in the search response; sending it back as one would be a different kind of write.
  const body = buildPatch(filled, [IT_COSTS], ok);
  expect(body.lineItems[0]!.analyticalFieldValues.some((v) => v.fieldId === "2avcxkezrxmosd")).toBe(false);
});

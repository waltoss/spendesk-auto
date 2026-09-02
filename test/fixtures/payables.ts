// Real payables, copied verbatim from GET /v1/payables/{id} and trimmed to the fields the
// guards read. Using invented shapes here would test the test, not the code.
//
// They are typed as the parsed `Payable`, which is itself a small assertion: if the schema
// and the real responses ever drift apart, these stop compiling.
import type { FieldAssignment } from "../../src/spendesk/write.ts";
import type { Payable } from "../../src/schemas/spendesk.ts";

export const MEMBER_ID = "9qytin56a08wku";

/** A blank meal payable: no fields, one line item, VAT-free. */
export const blank: Payable = {
  id: "3fccd8d9-cc39-5fdb-b654-71fa328bd6a2",
  version: 2,
  userId: MEMBER_ID,
  amount: 1708,
  currency: "EUR",
  exportedAt: null,
  costCenterId: "523175aa-3bea-47e2-839c-4b217c301c7e",
  analyticalProperties: [],
  lineItems: [
    {
      expenseAccount: null,
      vatAccount: null,
      financial: { vatAmount: 0, vatAdjustmentAmount: 0, netAmount: 1708, grossAmount: 1708 },
      analyticalProperties: [],
      costCenterId: "523175aa-3bea-47e2-839c-4b217c301c7e",
    },
  ],
};

/** An already-filled payable: correcting one field must leave the other two alone. */
export const filled: Payable = {
  id: "504217c5-9137-5ad5-85ba-b11576e7058e",
  version: 5,
  userId: MEMBER_ID,
  amount: 2200,
  currency: "USD",
  exportedAt: null,
  costCenterId: "523175aa-3bea-47e2-839c-4b217c301c7e",
  analyticalProperties: [],
  lineItems: [
    {
      expenseAccount: null,
      vatAccount: null,
      financial: { vatAmount: 0, vatAdjustmentAmount: 0, netAmount: 2200, grossAmount: 2200 },
      analyticalProperties: [
        { fieldId: "0ih_9b1mfr0mzs", valueId: "i8sb9djid4q-5p" },
        { fieldId: "piq72409umm1_s", valueId: "1x_tgrnnd72m2m" },
        { fieldId: "qrabw6on0c4jha", valueId: "d0jhoywyefbndo" },
      ],
      costCenterId: "523175aa-3bea-47e2-839c-4b217c301c7e",
    },
  ],
};

export const IT_COSTS: FieldAssignment = { fieldId: "piq72409umm1_s", valueId: "j7jxkhebt95798" };

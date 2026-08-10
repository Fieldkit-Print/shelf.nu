import type { BillableEventKind } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

// why: push.server imports the Prisma client and the Productive REST client at
// module scope. These tests cover the pure rollup and naming logic, which
// decides what a customer is actually charged — no network or database.
vi.mock("~/database/db.server", () => ({
  db: {
    billableEvent: { findMany: vi.fn() },
    customer: { findUnique: vi.fn() },
  },
}));
vi.mock("~/utils/env", () => ({
  FIELDKIT_PRIMARY_ORGANIZATION_ID: "org-1",
  PRODUCTIVE_API_TOKEN: "token",
  PRODUCTIVE_ORGANIZATION_ID: "59606",
}));

const { groupEventsForPush, storageBudgetName } = await import("./push.server");

/** Builds a ledger row with only the fields the rollup reads. */
function event(
  id: string,
  customerId: string,
  kind: BillableEventKind,
  amountCents: number | null,
  quantity = 1
) {
  return { id, customerId, kind, amountCents, currencyCode: "USD", quantity };
}

describe("groupEventsForPush", () => {
  it("rolls many events of one kind and rate into a single charge line", () => {
    const { groups } = groupEventsForPush([
      event("e1", "cust-1", "STORAGE", 5000),
      event("e2", "cust-1", "STORAGE", 5000),
      event("e3", "cust-1", "STORAGE", 5000),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      customerId: "cust-1",
      kind: "STORAGE",
      amountCents: 5000,
      quantity: 3,
    });
    expect(groups[0].eventIds).toHaveLength(3);
  });

  it("keeps different rates apart so quantity x price stays exact", () => {
    // A customer with a standard pallet and a tall pallet must not have the
    // two averaged into one line.
    const { groups } = groupEventsForPush([
      event("e1", "cust-1", "STORAGE", 5000),
      event("e2", "cust-1", "STORAGE", 8000),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.amountCents).sort((a, b) => a - b)).toEqual([
      5000, 8000,
    ]);
  });

  it("separates customers", () => {
    const { groups } = groupEventsForPush([
      event("e1", "cust-1", "STORAGE", 5000),
      event("e2", "cust-2", "STORAGE", 5000),
    ]);

    expect(groups).toHaveLength(2);
  });

  it("separates kinds", () => {
    const { groups } = groupEventsForPush([
      event("e1", "cust-1", "STORAGE", 5000),
      event("e2", "cust-1", "PICK", 12500),
    ]);

    expect(groups).toHaveLength(2);
  });

  it("sums quantity rather than counting rows", () => {
    // CONSUMABLE_USE carries a quantity above 1.
    const { groups } = groupEventsForPush([
      event("e1", "cust-1", "CONSUMABLE_USE", 250, 4),
      event("e2", "cust-1", "CONSUMABLE_USE", 250, 6),
    ]);

    expect(groups[0].quantity).toBe(10);
  });

  it("refuses to bill events with no resolved rate", () => {
    // A null amount means no rate was configured when the event was written.
    // Inventing a price at push time would bill a number nobody agreed to.
    const { groups, unpriced } = groupEventsForPush([
      event("e1", "cust-1", "STORAGE", null),
      event("e2", "cust-1", "STORAGE", 5000),
    ]);

    expect(unpriced).toBe(1);
    expect(groups).toHaveLength(1);
    expect(groups[0].eventIds).toEqual(["e2"]);
  });

  it("returns nothing for an empty month", () => {
    expect(groupEventsForPush([])).toEqual({ groups: [], unpriced: 0 });
  });
});

describe("storageBudgetName", () => {
  it("derives a stable per-customer, per-year budget name", () => {
    expect(storageBudgetName("Hoka", 2026)).toBe("Hoka — Storage 2026");
  });

  it("changes with the year so each year gets its own book", () => {
    expect(storageBudgetName("Nike", 2026)).not.toBe(
      storageBudgetName("Nike", 2027)
    );
  });
});

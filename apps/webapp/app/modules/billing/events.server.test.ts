import { describe, expect, it, beforeEach, vi } from "vitest";

// why: events.server imports the Prisma client at module scope; these tests
// exercise pallet grouping and idempotency-key derivation, neither of which
// touches the database.
vi.mock("~/database/db.server", () => ({
  db: {
    billableEvent: {
      upsert: vi.fn(),
    },
  },
}));

const { db } = await import("~/database/db.server");
const { groupAssetsIntoPallets, recordPick, recordReturn } = await import(
  "./events.server"
);

const upsertMock = vi.mocked(db.billableEvent.upsert);

/** Builds an asset row with only the fields grouping cares about. */
function asset(
  id: string,
  customerId: string | null,
  locationId: string | null
) {
  return { id, customerId, locationId };
}

describe("groupAssetsIntoPallets", () => {
  it("collapses assets sharing a pallet position into one billable unit", () => {
    const units = groupAssetsIntoPallets([
      asset("a1", "cust-1", "slot-A"),
      asset("a2", "cust-1", "slot-A"),
      asset("a3", "cust-1", "slot-A"),
    ]);

    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({
      customerId: "cust-1",
      locationId: "slot-A",
      assetCount: 3,
    });
  });

  it("bills each occupied position separately", () => {
    const units = groupAssetsIntoPallets([
      asset("a1", "cust-1", "slot-A"),
      asset("a2", "cust-1", "slot-B"),
    ]);

    expect(units).toHaveLength(2);
    expect(units.map((u) => u.locationId).sort()).toEqual(["slot-A", "slot-B"]);
  });

  it("ignores Fieldkit-owned assets, which have no customer to bill", () => {
    const units = groupAssetsIntoPallets([
      asset("a1", null, "slot-A"),
      asset("a2", "cust-1", "slot-B"),
    ]);

    expect(units).toHaveLength(1);
    expect(units[0].customerId).toBe("cust-1");
  });

  it("keeps unslotted assets as separate units rather than merging them", () => {
    const units = groupAssetsIntoPallets([
      asset("a1", "cust-1", null),
      asset("a2", "cust-1", null),
    ]);

    expect(units).toHaveLength(2);
  });

  it("does not merge two customers' goods found in the same position", () => {
    // Capacity 1 should prevent this, but if a position is misconfigured the
    // charge must still be attributable rather than silently assigned to one.
    const units = groupAssetsIntoPallets([
      asset("a1", "cust-1", "slot-A"),
      asset("a2", "cust-2", "slot-A"),
    ]);

    expect(units).toHaveLength(2);
    expect(units.map((u) => u.customerId).sort()).toEqual(["cust-1", "cust-2"]);
  });

  it("returns nothing for an empty booking", () => {
    expect(groupAssetsIntoPallets([])).toEqual([]);
  });
});

describe("handling charge idempotency", () => {
  beforeEach(() => {
    upsertMock.mockReset();
    // The production call passes `select: { id: true }`, so the real return is
    // just an id — but Prisma's default overload types it as the full model.
    // These tests assert on call arguments, not the return value.
    upsertMock.mockResolvedValue({ id: "evt-1" } as never);
  });

  const baseArgs = {
    organizationId: "org-1",
    customerId: "cust-1",
    bookingId: "booking-1",
    locationId: "slot-A",
    assetId: "a1",
    amountCents: 12500,
    currencyCode: "USD",
  };

  it("derives the same key for a repeated pick on one booking and pallet", async () => {
    // The bug this guards: keys used to hash occurredAt to the millisecond,
    // so a double-clicked check-out minted a fresh key and billed twice.
    await recordPick({
      ...baseArgs,
      occurredAt: new Date("2026-08-01T10:00:00Z"),
    });
    await recordPick({
      ...baseArgs,
      occurredAt: new Date("2026-08-01T10:00:05Z"),
    });

    const [first, second] = upsertMock.mock.calls;
    expect(first[0].where.idempotencyKey).toBe(second[0].where.idempotencyKey);
  });

  it("distinguishes a pick from a return on the same pallet", async () => {
    const occurredAt = new Date("2026-08-01T10:00:00Z");
    await recordPick({ ...baseArgs, occurredAt });
    await recordReturn({ ...baseArgs, occurredAt });

    const [pick, ret] = upsertMock.mock.calls;
    expect(pick[0].where.idempotencyKey).not.toBe(ret[0].where.idempotencyKey);
  });

  it("distinguishes different pallets on the same booking", async () => {
    const occurredAt = new Date("2026-08-01T10:00:00Z");
    await recordPick({ ...baseArgs, locationId: "slot-A", occurredAt });
    await recordPick({ ...baseArgs, locationId: "slot-B", occurredAt });

    const [a, b] = upsertMock.mock.calls;
    expect(a[0].where.idempotencyKey).not.toBe(b[0].where.idempotencyKey);
  });

  it("distinguishes the same pallet across different bookings", async () => {
    const occurredAt = new Date("2026-08-01T10:00:00Z");
    await recordPick({ ...baseArgs, bookingId: "booking-1", occurredAt });
    await recordPick({ ...baseArgs, bookingId: "booking-2", occurredAt });

    const [a, b] = upsertMock.mock.calls;
    expect(a[0].where.idempotencyKey).not.toBe(b[0].where.idempotencyKey);
  });

  it("falls back to the asset id when the asset is unslotted", async () => {
    const occurredAt = new Date("2026-08-01T10:00:00Z");
    await recordPick({
      ...baseArgs,
      locationId: null,
      assetId: "a1",
      occurredAt,
    });
    await recordPick({
      ...baseArgs,
      locationId: null,
      assetId: "a2",
      occurredAt,
    });

    const [a, b] = upsertMock.mock.calls;
    expect(a[0].where.idempotencyKey).not.toBe(b[0].where.idempotencyKey);
  });

  it("writes through the supplied transaction client, not the global db", async () => {
    // The bug this guards: charges committed even when the surrounding
    // checkout transaction rolled back.
    const txUpsert = vi.fn().mockResolvedValue({ id: "evt-tx" });
    const tx = { billableEvent: { upsert: txUpsert } };

    await recordPick(
      { ...baseArgs, occurredAt: new Date("2026-08-01T10:00:00Z") },
      tx
    );

    expect(txUpsert).toHaveBeenCalledTimes(1);
    expect(upsertMock).not.toHaveBeenCalled();
  });
});

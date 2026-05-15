-- Shipstation Phase 1: structured ship-to + integration columns on
-- BookingRequest, plus shipping dimensions on Asset.

-- BookingRequest: drop legacy single-line shipping field, add structured
-- ship-to columns plus Shipstation tracking state.
ALTER TABLE "BookingRequest" DROP COLUMN IF EXISTS "shippingAddress";

ALTER TABLE "BookingRequest"
  ADD COLUMN "shipToName"    TEXT,
  ADD COLUMN "shipToPhone"   TEXT,
  ADD COLUMN "shipToLine1"   TEXT,
  ADD COLUMN "shipToLine2"   TEXT,
  ADD COLUMN "shipToCity"    TEXT,
  ADD COLUMN "shipToState"   TEXT,
  ADD COLUMN "shipToPostal"  TEXT,
  ADD COLUMN "shipToCountry" TEXT;

ALTER TABLE "BookingRequest"
  ADD COLUMN "shipstationOrderId"              TEXT,
  ADD COLUMN "shipstationShippedAt"            TIMESTAMPTZ(3),
  ADD COLUMN "shipstationTrackingNumber"       TEXT,
  ADD COLUMN "shipstationCarrier"              TEXT,
  ADD COLUMN "shipstationReturnLabelCreatedAt" TIMESTAMPTZ(3),
  ADD COLUMN "shipstationReturnTrackingNumber" TEXT,
  ADD COLUMN "shipstationReturnDeliveredAt"    TIMESTAMPTZ(3);

-- Shipstation polls the export endpoint with a date range; the index on
-- (status, updatedAt) supports the "approved orders modified since X"
-- query that produces every poll response.
CREATE INDEX "BookingRequest_status_updatedAt_idx"
  ON "BookingRequest" ("status", "updatedAt");

-- Asset: shipping dimensions captured once per SKU and reused by every
-- outbound order. All nullable — Shipstation accepts orders without them.
ALTER TABLE "Asset"
  ADD COLUMN "weightOz" DECIMAL(10,3),
  ADD COLUMN "lengthIn" DECIMAL(10,3),
  ADD COLUMN "widthIn"  DECIMAL(10,3),
  ADD COLUMN "heightIn" DECIMAL(10,3);

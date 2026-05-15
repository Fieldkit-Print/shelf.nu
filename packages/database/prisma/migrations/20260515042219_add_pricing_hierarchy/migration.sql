-- =============================================================================
-- Pricing hierarchy (Shelf as source of truth)
--
-- Three-tier rate hierarchy: asset → customer → org. Resolver walks these
-- in order and returns the first non-null hit per pricing kind.
-- =============================================================================

-- CreateTable: OrgPricing (one row per Organization, fallback tier)
CREATE TABLE "OrgPricing" (
    "organizationId" TEXT NOT NULL,
    "storagePerDayCents" INTEGER,
    "pickCents" INTEGER,
    "returnCents" INTEGER,
    "rentalPerDayCents" INTEGER,
    "rentalLossMultiplier" DECIMAL(6,4),
    "consumableMarkupPct" DECIMAL(6,4),
    "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrgPricing_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable: CustomerPricing (per-customer override, no FK on carbonCustomerId)
CREATE TABLE "CustomerPricing" (
    "carbonCustomerId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "storagePerDayCents" INTEGER,
    "pickCents" INTEGER,
    "returnCents" INTEGER,
    "rentalPerDayCents" INTEGER,
    "rentalLossMultiplier" DECIMAL(6,4),
    "consumableMarkupPct" DECIMAL(6,4),
    "currencyCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerPricing_pkey" PRIMARY KEY ("carbonCustomerId")
);

-- CreateTable: AssetPricing (per-asset override; only storage + rental rates)
CREATE TABLE "AssetPricing" (
    "assetId" TEXT NOT NULL,
    "storagePerDayCents" INTEGER,
    "rentalPerDayCents" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssetPricing_pkey" PRIMARY KEY ("assetId")
);

CREATE INDEX "CustomerPricing_organizationId_idx" ON "CustomerPricing"("organizationId");

ALTER TABLE "OrgPricing" ADD CONSTRAINT "OrgPricing_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CustomerPricing" ADD CONSTRAINT "CustomerPricing_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AssetPricing" ADD CONSTRAINT "AssetPricing_assetId_fkey"
  FOREIGN KEY ("assetId") REFERENCES "Asset"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrgPricing" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomerPricing" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssetPricing" ENABLE ROW LEVEL SECURITY;

-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('INSTANCE', 'CONSUMABLE');

-- CreateEnum
CREATE TYPE "BillableEventStatus" AS ENUM ('PENDING', 'PUSHED', 'FAILED', 'IGNORED');

-- CreateEnum
CREATE TYPE "BillableEventKind" AS ENUM ('STORAGE', 'PICK', 'RETURN', 'RENTAL_USE', 'RENTAL_LOSS', 'CONSUMABLE_USE');

-- AlterEnum
ALTER TYPE "OrganizationRoles" ADD VALUE 'CUSTOMER';

-- AlterTable
ALTER TABLE "Asset" ADD COLUMN     "carbonCustomerId" TEXT,
ADD COLUMN     "carbonPartId" TEXT,
ADD COLUMN     "kind" "AssetKind" NOT NULL DEFAULT 'INSTANCE',
ADD COLUMN     "rentable" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "carbonContactId" TEXT,
ADD COLUMN     "carbonCustomerId" TEXT;

-- CreateTable
CREATE TABLE "CustomerContactPermission" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "canRequestShipment" BOOLEAN NOT NULL DEFAULT true,
    "canRequestReturn" BOOLEAN NOT NULL DEFAULT true,
    "canRentInventory" BOOLEAN NOT NULL DEFAULT false,
    "canViewBilling" BOOLEAN NOT NULL DEFAULT false,
    "canManageOtherContacts" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerContactPermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingAssetMeta" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "quantityOut" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "quantityReturned" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingAssetMeta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillableEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "BillableEventKind" NOT NULL,
    "status" "BillableEventStatus" NOT NULL DEFAULT 'PENDING',
    "carbonCustomerId" TEXT NOT NULL,
    "assetId" TEXT,
    "carbonPartId" TEXT,
    "locationId" TEXT,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "amountCents" INTEGER,
    "currencyCode" TEXT,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "periodStart" TIMESTAMPTZ(3),
    "periodEnd" TIMESTAMPTZ(3),
    "carbonInvoiceLineId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "lastPushAttemptedAt" TIMESTAMPTZ(3),
    "lastPushError" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BillableEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerContactPermission_userId_key" ON "CustomerContactPermission"("userId");

-- CreateIndex
CREATE INDEX "BookingAssetMeta_assetId_idx" ON "BookingAssetMeta"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingAssetMeta_bookingId_assetId_key" ON "BookingAssetMeta"("bookingId", "assetId");

-- CreateIndex
CREATE UNIQUE INDEX "BillableEvent_idempotencyKey_key" ON "BillableEvent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "BillableEvent_organizationId_status_idx" ON "BillableEvent"("organizationId", "status");

-- CreateIndex
CREATE INDEX "BillableEvent_carbonCustomerId_occurredAt_idx" ON "BillableEvent"("carbonCustomerId", "occurredAt");

-- CreateIndex
CREATE INDEX "BillableEvent_assetId_idx" ON "BillableEvent"("assetId");

-- CreateIndex
CREATE INDEX "BillableEvent_kind_status_occurredAt_idx" ON "BillableEvent"("kind", "status", "occurredAt");

-- CreateIndex
CREATE INDEX "Asset_organizationId_carbonCustomerId_idx" ON "Asset"("organizationId", "carbonCustomerId");

-- CreateIndex
CREATE INDEX "Asset_organizationId_rentable_idx" ON "Asset"("organizationId", "rentable");

-- CreateIndex
CREATE INDEX "Asset_organizationId_kind_idx" ON "Asset"("organizationId", "kind");

-- CreateIndex
CREATE INDEX "Asset_carbonPartId_idx" ON "Asset"("carbonPartId");

-- CreateIndex
CREATE UNIQUE INDEX "User_carbonContactId_key" ON "User"("carbonContactId");

-- CreateIndex
CREATE INDEX "User_carbonCustomerId_idx" ON "User"("carbonCustomerId");

-- CreateIndex
CREATE INDEX "User_carbonContactId_idx" ON "User"("carbonContactId");

-- AddForeignKey
ALTER TABLE "CustomerContactPermission" ADD CONSTRAINT "CustomerContactPermission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingAssetMeta" ADD CONSTRAINT "BookingAssetMeta_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingAssetMeta" ADD CONSTRAINT "BookingAssetMeta_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillableEvent" ADD CONSTRAINT "BillableEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillableEvent" ADD CONSTRAINT "BillableEvent_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;


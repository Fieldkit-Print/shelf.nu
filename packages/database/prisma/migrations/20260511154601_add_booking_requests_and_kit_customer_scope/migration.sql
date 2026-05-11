-- =============================================================================
-- BookingRequest entity + kit customer-scope fields + per-customer settings
--
-- Adds the data model behind the Fieldkit customer-portal request/approval
-- flow, plus the Kit-level tenancy fields that mirror Asset.carbonCustomerId.
-- See superpowers/plans/2026-05-11-customer-tenancy-and-requests.md.
-- =============================================================================

-- CreateEnum
CREATE TYPE "BookingRequestStatus" AS ENUM ('DRAFT', 'PENDING_INTERNAL', 'PENDING_FIELDKIT', 'APPROVED', 'REJECTED', 'CANCELLED');

-- AlterEnum: ActivityEntity gains BOOKING_REQUEST
ALTER TYPE "ActivityEntity" ADD VALUE 'BOOKING_REQUEST';

-- AlterEnum: ActivityAction gains BookingRequest lifecycle actions
ALTER TYPE "ActivityAction" ADD VALUE 'BOOKING_REQUEST_SUBMITTED';
ALTER TYPE "ActivityAction" ADD VALUE 'BOOKING_REQUEST_INTERNAL_APPROVED';
ALTER TYPE "ActivityAction" ADD VALUE 'BOOKING_REQUEST_INTERNAL_REJECTED';
ALTER TYPE "ActivityAction" ADD VALUE 'BOOKING_REQUEST_FIELDKIT_APPROVED';
ALTER TYPE "ActivityAction" ADD VALUE 'BOOKING_REQUEST_FIELDKIT_REJECTED';
ALTER TYPE "ActivityAction" ADD VALUE 'BOOKING_REQUEST_CANCELLED';

-- AlterTable: Kit gains customer ownership + rentable flag
ALTER TABLE "Kit"
  ADD COLUMN "carbonCustomerId" TEXT,
  ADD COLUMN "rentable" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: CustomerContactPermission gains booking-approval flag
ALTER TABLE "CustomerContactPermission"
  ADD COLUMN "canApproveBookings" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable: CustomerSetting (Shelf-local per-customer config)
CREATE TABLE "CustomerSetting" (
    "carbonCustomerId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "requiresInternalApproval" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerSetting_pkey" PRIMARY KEY ("carbonCustomerId")
);

-- CreateTable: BookingRequest
CREATE TABLE "BookingRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "carbonCustomerId" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "status" "BookingRequestStatus" NOT NULL DEFAULT 'DRAFT',
    "rejectionReason" TEXT,
    "internalApproverId" TEXT,
    "internalApprovedAt" TIMESTAMP(3),
    "fieldkitApproverId" TEXT,
    "fieldkitApprovedAt" TIMESTAMP(3),
    "proposedFrom" TIMESTAMPTZ(3) NOT NULL,
    "proposedTo" TIMESTAMPTZ(3) NOT NULL,
    "shippingAddress" TEXT,
    "notes" TEXT,
    "bookingId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BookingRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable: implicit M2M Asset ↔ BookingRequest
CREATE TABLE "_BookingRequestAssets" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_BookingRequestAssets_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable: implicit M2M Kit ↔ BookingRequest
CREATE TABLE "_BookingRequestKits" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_BookingRequestKits_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex: Kit composite (organizationId, carbonCustomerId)
CREATE INDEX "Kit_organizationId_carbonCustomerId_idx" ON "Kit"("organizationId", "carbonCustomerId");

-- CreateIndex: CustomerSetting (organizationId) for org-wide lookups
CREATE INDEX "CustomerSetting_organizationId_idx" ON "CustomerSetting"("organizationId");

-- CreateIndex: BookingRequest unique bookingId (1:1 with Booking)
CREATE UNIQUE INDEX "BookingRequest_bookingId_key" ON "BookingRequest"("bookingId");

-- CreateIndex: BookingRequest queue / scope indexes
CREATE INDEX "BookingRequest_carbonCustomerId_status_idx" ON "BookingRequest"("carbonCustomerId", "status");
CREATE INDEX "BookingRequest_organizationId_status_idx" ON "BookingRequest"("organizationId", "status");
CREATE INDEX "BookingRequest_requesterId_idx" ON "BookingRequest"("requesterId");
CREATE INDEX "BookingRequest_internalApproverId_idx" ON "BookingRequest"("internalApproverId");
CREATE INDEX "BookingRequest_fieldkitApproverId_idx" ON "BookingRequest"("fieldkitApproverId");

-- CreateIndex: M2M secondary indexes (Prisma convention: B column)
CREATE INDEX "_BookingRequestAssets_B_index" ON "_BookingRequestAssets"("B");
CREATE INDEX "_BookingRequestKits_B_index" ON "_BookingRequestKits"("B");

-- AddForeignKey: CustomerSetting → Organization
ALTER TABLE "CustomerSetting" ADD CONSTRAINT "CustomerSetting_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: BookingRequest → Organization
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: BookingRequest → User (requester, internal approver, fieldkit approver)
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_requesterId_fkey"
  FOREIGN KEY ("requesterId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_internalApproverId_fkey"
  FOREIGN KEY ("internalApproverId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_fieldkitApproverId_fkey"
  FOREIGN KEY ("fieldkitApproverId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: BookingRequest → Booking (set on approval)
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "Booking"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: M2M join → Asset/Kit + BookingRequest
ALTER TABLE "_BookingRequestAssets" ADD CONSTRAINT "_BookingRequestAssets_A_fkey"
  FOREIGN KEY ("A") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "_BookingRequestAssets" ADD CONSTRAINT "_BookingRequestAssets_B_fkey"
  FOREIGN KEY ("B") REFERENCES "BookingRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "_BookingRequestKits" ADD CONSTRAINT "_BookingRequestKits_A_fkey"
  FOREIGN KEY ("A") REFERENCES "Kit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "_BookingRequestKits" ADD CONSTRAINT "_BookingRequestKits_B_fkey"
  FOREIGN KEY ("B") REFERENCES "BookingRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Enable RLS on new tables (Supabase pattern — matches ActivityEvent etc.)
ALTER TABLE "CustomerSetting" ENABLE row level security;
ALTER TABLE "BookingRequest" ENABLE row level security;

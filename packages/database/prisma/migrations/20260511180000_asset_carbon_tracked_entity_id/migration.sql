-- AlterTable
ALTER TABLE "Asset" ADD COLUMN "carbonTrackedEntityId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Asset_carbonTrackedEntityId_key" ON "Asset"("carbonTrackedEntityId");

-- CreateTable
CREATE TABLE "StoredObject" (
    "key" TEXT NOT NULL,
    "tenantId" TEXT,
    "contentType" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "sha256" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoredObject_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "StoredObject_tenantId_idx" ON "StoredObject"("tenantId");

-- CreateIndex
CREATE INDEX "StoredObject_createdAt_idx" ON "StoredObject"("createdAt");

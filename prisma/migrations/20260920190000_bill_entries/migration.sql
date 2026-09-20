-- CreateEnum
CREATE TYPE "BillEntryStatus" AS ENUM ('REVIEW', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "BillEntryKind" AS ENUM ('BILL', 'EXPENSE');

-- CreateTable
CREATE TABLE "BillEntry" (
    "id" TEXT NOT NULL,
    "status" "BillEntryStatus" NOT NULL DEFAULT 'REVIEW',
    "kind" "BillEntryKind" NOT NULL DEFAULT 'BILL',
    "vendor" TEXT,
    "invoiceNumber" TEXT,
    "amount" DECIMAL(14,2),
    "billDate" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "category" TEXT,
    "paid" BOOLEAN NOT NULL DEFAULT false,
    "paymentMethod" TEXT,
    "notes" TEXT,
    "fileName" TEXT,
    "storedPath" TEXT,
    "mimeType" TEXT,
    "size" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'UPLOAD',
    "supplierInvoiceId" TEXT,
    "expenseId" TEXT,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BillEntry_status_idx" ON "BillEntry"("status");

-- CreateIndex
CREATE INDEX "BillEntry_createdAt_idx" ON "BillEntry"("createdAt");

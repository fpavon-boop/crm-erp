/*
  Warnings:

  - A unique constraint covering the columns `[quoteId]` on the table `SalesOrder` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "SalesOrder_quoteId_key" ON "SalesOrder"("quoteId");

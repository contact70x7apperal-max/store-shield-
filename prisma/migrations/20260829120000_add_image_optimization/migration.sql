-- CreateTable
CREATE TABLE "ImageOptimization" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "originalMediaId" TEXT NOT NULL,
    "newMediaId" TEXT,
    "originalBytes" INTEGER NOT NULL,
    "newBytes" INTEGER,
    "maxWidth" INTEGER NOT NULL,
    "quality" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ImageOptimization_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImageOptimization_shop_createdAt_idx" ON "ImageOptimization"("shop", "createdAt");

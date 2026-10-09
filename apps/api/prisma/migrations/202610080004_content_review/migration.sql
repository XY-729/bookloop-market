ALTER TABLE "Media" ADD COLUMN "reviewState" TEXT NOT NULL DEFAULT 'PENDING', ADD COLUMN "reviewSource" TEXT NOT NULL DEFAULT 'unknown';
UPDATE "Media" SET "reviewState"='APPROVED',"reviewSource"='private-document' WHERE "purpose"='IDENTITY';
CREATE TABLE "MediaCheck" ("id" TEXT NOT NULL,"mediaId" TEXT NOT NULL,"traceId" TEXT,"status" TEXT NOT NULL DEFAULT 'PENDING',"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,CONSTRAINT "MediaCheck_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "MediaCheck_traceId_key" ON "MediaCheck"("traceId");
CREATE INDEX "MediaCheck_mediaId_idx" ON "MediaCheck"("mediaId");
ALTER TABLE "MediaCheck" ADD CONSTRAINT "MediaCheck_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TABLE "WechatMediaEvent" ("traceId" TEXT NOT NULL,"payload" JSONB NOT NULL,"receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,CONSTRAINT "WechatMediaEvent_pkey" PRIMARY KEY ("traceId"));

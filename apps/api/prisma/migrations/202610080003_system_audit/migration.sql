ALTER TABLE "Audit" ALTER COLUMN "actorId" DROP NOT NULL;
CREATE UNIQUE INDEX "one_application_per_identity_media" ON "Verification"("mediaId");

-- No data preserved by this migration — ParticipantAnalysis has never had
-- a successful write yet (confirmed via the agent's own logs), so this is
-- a clean rename/replace rather than a data-preserving migration.

-- DropColumn
ALTER TABLE "ParticipantAnalysis" DROP COLUMN "topicRelevancy";
ALTER TABLE "ParticipantAnalysis" DROP COLUMN "engagement";
ALTER TABLE "ParticipantAnalysis" DROP COLUMN "clarityConfidence";

-- AddColumn
ALTER TABLE "ParticipantAnalysis" ADD COLUMN "topicKnowledge" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ParticipantAnalysis" ADD COLUMN "teamworkListening" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ParticipantAnalysis" ADD COLUMN "leadershipInitiative" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ParticipantAnalysis" ADD COLUMN "confidenceProfessionalism" INTEGER NOT NULL DEFAULT 0;

-- The DEFAULT 0 above is only to satisfy existing rows (there are none in
-- practice) during the ALTER — drop the default afterward so the
-- application is required to supply a real value on every future insert,
-- matching how communication/fluency (never had a default) already work.
ALTER TABLE "ParticipantAnalysis" ALTER COLUMN "topicKnowledge" DROP DEFAULT;
ALTER TABLE "ParticipantAnalysis" ALTER COLUMN "teamworkListening" DROP DEFAULT;
ALTER TABLE "ParticipantAnalysis" ALTER COLUMN "leadershipInitiative" DROP DEFAULT;
ALTER TABLE "ParticipantAnalysis" ALTER COLUMN "confidenceProfessionalism" DROP DEFAULT;

CREATE TABLE "Contest" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "startAt" TIMESTAMP(3) NOT NULL,
  "endAt" TIMESTAMP(3) NOT NULL,
  "isPublished" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Contest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Contest_slug_key" ON "Contest"("slug");
CREATE INDEX "Contest_isPublished_startAt_idx" ON "Contest"("isPublished", "startAt");

CREATE TABLE "ContestProblem" (
  "contestId" TEXT NOT NULL,
  "problemId" TEXT NOT NULL,
  "points" INTEGER NOT NULL DEFAULT 100,
  "position" INTEGER NOT NULL,
  CONSTRAINT "ContestProblem_pkey" PRIMARY KEY ("contestId", "problemId")
);

CREATE UNIQUE INDEX "ContestProblem_contestId_position_key"
  ON "ContestProblem"("contestId", "position");
CREATE INDEX "ContestProblem_problemId_idx" ON "ContestProblem"("problemId");

CREATE TABLE "ContestParticipant" (
  "contestId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContestParticipant_pkey" PRIMARY KEY ("contestId", "userId")
);

CREATE UNIQUE INDEX "ContestParticipant_contestId_displayName_key"
  ON "ContestParticipant"("contestId", "displayName");
CREATE INDEX "ContestParticipant_contestId_joinedAt_idx"
  ON "ContestParticipant"("contestId", "joinedAt");

ALTER TABLE "Submission" ADD COLUMN "contestId" TEXT;
CREATE INDEX "Submission_contestId_status_createdAt_idx"
  ON "Submission"("contestId", "status", "createdAt");

ALTER TABLE "ContestProblem"
  ADD CONSTRAINT "ContestProblem_contestId_fkey"
  FOREIGN KEY ("contestId") REFERENCES "Contest"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ContestProblem_problemId_fkey"
  FOREIGN KEY ("problemId") REFERENCES "Problem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ContestParticipant"
  ADD CONSTRAINT "ContestParticipant_contestId_fkey"
  FOREIGN KEY ("contestId") REFERENCES "Contest"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ContestParticipant_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Submission"
  ADD CONSTRAINT "Submission_contestId_fkey"
  FOREIGN KEY ("contestId") REFERENCES "Contest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

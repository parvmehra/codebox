CREATE TYPE "SubmissionLanguage" AS ENUM ('JAVA', 'PYTHON', 'CPP', 'NODEJS');
CREATE TYPE "SubmissionStatus" AS ENUM (
  'QUEUED',
  'ASSIGNED',
  'STARTING',
  'COMPILING',
  'RUNNING',
  'ACCEPTED',
  'WRONG_ANSWER',
  'TIME_LIMIT_EXCEEDED',
  'MEMORY_LIMIT_EXCEEDED',
  'COMPILATION_ERROR',
  'RUNTIME_ERROR',
  'SYSTEM_ERROR',
  'CANCELLED'
);

CREATE TABLE "Submission" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "problemId" TEXT NOT NULL,
  "language" "SubmissionLanguage" NOT NULL,
  "sourceCode" TEXT NOT NULL,
  "status" "SubmissionStatus" NOT NULL DEFAULT 'QUEUED',
  "executionTimeMs" INTEGER,
  "memoryUsedKb" INTEGER,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Submission_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Submission_userId_createdAt_idx" ON "Submission"("userId", "createdAt");
CREATE INDEX "Submission_problemId_status_idx" ON "Submission"("problemId", "status");

ALTER TABLE "Submission"
  ADD CONSTRAINT "Submission_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Submission"
  ADD CONSTRAINT "Submission_problemId_fkey"
  FOREIGN KEY ("problemId") REFERENCES "Problem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

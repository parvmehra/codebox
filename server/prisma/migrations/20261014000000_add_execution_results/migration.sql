CREATE TYPE "TestResultStatus" AS ENUM (
  'PASSED',
  'WRONG_ANSWER',
  'TIME_LIMIT_EXCEEDED',
  'MEMORY_LIMIT_EXCEEDED',
  'RUNTIME_ERROR'
);

CREATE TABLE "Execution" (
  "id" TEXT NOT NULL,
  "submissionId" TEXT NOT NULL,
  "attemptNumber" INTEGER NOT NULL DEFAULT 1,
  "languageVersion" TEXT NOT NULL,
  "dockerImage" TEXT NOT NULL,
  "timeLimitMs" INTEGER NOT NULL,
  "memoryLimitMb" INTEGER NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "executionTimeMs" INTEGER,
  "memoryUsedKb" INTEGER,
  CONSTRAINT "Execution_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExecutionTestResult" (
  "id" TEXT NOT NULL,
  "executionId" TEXT NOT NULL,
  "testCaseId" TEXT,
  "testIndex" INTEGER NOT NULL,
  "status" "TestResultStatus" NOT NULL,
  "executionTimeMs" INTEGER,
  "errorMessage" TEXT,
  CONSTRAINT "ExecutionTestResult_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Execution_submissionId_attemptNumber_key"
  ON "Execution"("submissionId", "attemptNumber");
CREATE INDEX "Execution_submissionId_startedAt_idx"
  ON "Execution"("submissionId", "startedAt");
CREATE UNIQUE INDEX "ExecutionTestResult_executionId_testIndex_key"
  ON "ExecutionTestResult"("executionId", "testIndex");
CREATE INDEX "ExecutionTestResult_testCaseId_idx"
  ON "ExecutionTestResult"("testCaseId");

ALTER TABLE "Execution"
  ADD CONSTRAINT "Execution_submissionId_fkey"
  FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExecutionTestResult"
  ADD CONSTRAINT "ExecutionTestResult_executionId_fkey"
  FOREIGN KEY ("executionId") REFERENCES "Execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExecutionTestResult"
  ADD CONSTRAINT "ExecutionTestResult_testCaseId_fkey"
  FOREIGN KEY ("testCaseId") REFERENCES "TestCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

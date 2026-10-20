ALTER TABLE "TestCase"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "TestCaseVersion" (
  "testCaseId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "input" TEXT NOT NULL,
  "expectedOut" TEXT NOT NULL,
  "isHidden" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TestCaseVersion_pkey" PRIMARY KEY ("testCaseId", "version")
);

INSERT INTO "TestCaseVersion" ("testCaseId", "version", "input", "expectedOut", "isHidden", "createdAt")
SELECT "id", 1, "input", "expectedOut", "isHidden", "createdAt"
FROM "TestCase";

CREATE INDEX "TestCaseVersion_testCaseId_createdAt_idx"
  ON "TestCaseVersion"("testCaseId", "createdAt");

ALTER TABLE "TestCaseVersion"
  ADD CONSTRAINT "TestCaseVersion_testCaseId_fkey"
  FOREIGN KEY ("testCaseId") REFERENCES "TestCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Execution"
  ADD COLUMN "dockerImageDigest" TEXT,
  ADD COLUMN "dockerImageId" TEXT,
  ADD COLUMN "sourceCodeSha256" TEXT,
  ADD COLUMN "profileSnapshot" JSONB;

CREATE TABLE "ExecutionTestCase" (
  "id" TEXT NOT NULL,
  "executionId" TEXT NOT NULL,
  "testIndex" INTEGER NOT NULL,
  "testCaseId" TEXT NOT NULL,
  "testCaseVersion" INTEGER NOT NULL,
  CONSTRAINT "ExecutionTestCase_pkey" PRIMARY KEY ("id")
);

INSERT INTO "ExecutionTestCase" ("id", "executionId", "testIndex", "testCaseId", "testCaseVersion")
SELECT
  'legacy-' || execution."id" || '-' || case_order."testIndex",
  execution."id",
  case_order."testIndex",
  case_order."testCaseId",
  1
FROM "Execution" AS execution
JOIN "Submission" AS submission ON submission."id" = execution."submissionId"
JOIN LATERAL (
  SELECT
    test_case."id" AS "testCaseId",
    ROW_NUMBER() OVER (ORDER BY test_case."createdAt", test_case."id")::INTEGER AS "testIndex"
  FROM "TestCase" AS test_case
  WHERE test_case."problemId" = submission."problemId"
) AS case_order ON TRUE;

CREATE UNIQUE INDEX "ExecutionTestCase_executionId_testIndex_key"
  ON "ExecutionTestCase"("executionId", "testIndex");
CREATE INDEX "ExecutionTestCase_testCaseId_testCaseVersion_idx"
  ON "ExecutionTestCase"("testCaseId", "testCaseVersion");

ALTER TABLE "ExecutionTestCase"
  ADD CONSTRAINT "ExecutionTestCase_executionId_fkey"
  FOREIGN KEY ("executionId") REFERENCES "Execution"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ExecutionTestCase_testCaseId_testCaseVersion_fkey"
  FOREIGN KEY ("testCaseId", "testCaseVersion")
  REFERENCES "TestCaseVersion"("testCaseId", "version") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ExecutionTestResult"
  ADD COLUMN "executionTestCaseId" TEXT;

UPDATE "ExecutionTestResult" AS result
SET "executionTestCaseId" = execution_case."id"
FROM "ExecutionTestCase" AS execution_case
WHERE execution_case."executionId" = result."executionId"
  AND execution_case."testIndex" = result."testIndex";

CREATE UNIQUE INDEX "ExecutionTestResult_executionTestCaseId_key"
  ON "ExecutionTestResult"("executionTestCaseId");

ALTER TABLE "ExecutionTestResult"
  ADD CONSTRAINT "ExecutionTestResult_executionTestCaseId_fkey"
  FOREIGN KEY ("executionTestCaseId") REFERENCES "ExecutionTestCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Submission"
  ADD COLUMN "rerunOfExecutionId" TEXT;

CREATE INDEX "Submission_rerunOfExecutionId_idx"
  ON "Submission"("rerunOfExecutionId");

ALTER TABLE "Submission"
  ADD CONSTRAINT "Submission_rerunOfExecutionId_fkey"
  FOREIGN KEY ("rerunOfExecutionId") REFERENCES "Execution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

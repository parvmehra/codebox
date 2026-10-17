CREATE TYPE "WorkerStatus" AS ENUM ('ONLINE', 'OFFLINE');

ALTER TABLE "Submission"
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "workerId" TEXT,
  ADD COLUMN "leaseToken" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "lastEnqueuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "needsDispatch" BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX "Submission_status_leaseExpiresAt_idx"
  ON "Submission"("status", "leaseExpiresAt");
CREATE INDEX "Submission_status_lastEnqueuedAt_idx"
  ON "Submission"("status", "lastEnqueuedAt");
CREATE INDEX "Submission_status_needsDispatch_lastEnqueuedAt_idx"
  ON "Submission"("status", "needsDispatch", "lastEnqueuedAt");

CREATE TABLE "Worker" (
  "id" TEXT NOT NULL,
  "status" "WorkerStatus" NOT NULL DEFAULT 'ONLINE',
  "activeJobs" INTEGER NOT NULL DEFAULT 0,
  "lastHeartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Worker_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Worker_status_lastHeartbeatAt_idx"
  ON "Worker"("status", "lastHeartbeatAt");

CREATE TABLE "WorkerHeartbeat" (
  "id" TEXT NOT NULL,
  "workerId" TEXT NOT NULL,
  "status" "WorkerStatus" NOT NULL,
  "activeJobs" INTEGER NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WorkerHeartbeat_workerId_recordedAt_idx"
  ON "WorkerHeartbeat"("workerId", "recordedAt");

ALTER TABLE "WorkerHeartbeat"
  ADD CONSTRAINT "WorkerHeartbeat_workerId_fkey"
  FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE CASCADE ON UPDATE CASCADE;

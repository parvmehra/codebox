CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');
CREATE TYPE "Difficulty" AS ENUM ('EASY', 'MEDIUM', 'HARD');

CREATE TABLE "User" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "role" "Role" NOT NULL DEFAULT 'USER',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Problem" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "difficulty" "Difficulty" NOT NULL,
  "constraints" TEXT NOT NULL,
  "inputFormat" TEXT NOT NULL,
  "outputFormat" TEXT NOT NULL,
  "examples" JSONB NOT NULL,
  "isPublished" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Problem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TestCase" (
  "id" TEXT NOT NULL,
  "problemId" TEXT NOT NULL,
  "input" TEXT NOT NULL,
  "expectedOut" TEXT NOT NULL,
  "isHidden" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TestCase_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "Problem_slug_key" ON "Problem"("slug");
CREATE INDEX "Problem_isPublished_difficulty_idx" ON "Problem"("isPublished", "difficulty");
CREATE INDEX "TestCase_problemId_idx" ON "TestCase"("problemId");
ALTER TABLE "TestCase" ADD CONSTRAINT "TestCase_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "Problem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

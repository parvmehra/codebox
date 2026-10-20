import { Difficulty, PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  await prisma.problem.upsert({
    where: { slug: 'two-sum' },
    update: {},
    create: {
      slug: 'two-sum',
      title: 'Two Sum',
      description:
        'Given an array of integers and a target, return the indices of two numbers that add up to the target.',
      difficulty: Difficulty.EASY,
      constraints: '2 <= nums.length <= 10^4',
      inputFormat: 'An integer array nums and an integer target.',
      outputFormat: 'Two zero-based indices.',
      examples: [{ input: 'nums = [2, 7, 11, 15], target = 9', output: '[0, 1]' }],
      isPublished: true,
      testCases: {
        create: [
          {
            input: '4\n2 7 11 15\n9',
            expectedOut: '0 1',
            isHidden: false,
            versions: {
              create: { version: 1, input: '4\n2 7 11 15\n9', expectedOut: '0 1', isHidden: false },
            },
          },
        ],
      },
    },
  });

  const problem = await prisma.problem.findUniqueOrThrow({
    where: { slug: 'two-sum' },
    select: { id: true },
  });
  const legacyInput = String.raw`4\n2 7 11 15\n9`;
  const canonicalInput = '4\n2 7 11 15\n9';
  const legacyCases = await prisma.testCase.findMany({
    where: { problemId: problem.id, input: legacyInput },
    select: { id: true, version: true, expectedOut: true, isHidden: true },
  });
  for (const testCase of legacyCases) {
    const nextVersion = testCase.version + 1;
    await prisma.$transaction(async (transaction) => {
      const updated = await transaction.testCase.updateMany({
        where: { id: testCase.id, version: testCase.version },
        data: { input: canonicalInput, version: nextVersion },
      });
      if (updated.count !== 1) return;
      await transaction.testCaseVersion.create({
        data: {
          testCaseId: testCase.id,
          version: nextVersion,
          input: canonicalInput,
          expectedOut: testCase.expectedOut,
          isHidden: testCase.isHidden,
        },
      });
    });
  }
}
main().finally(() => prisma.$disconnect());

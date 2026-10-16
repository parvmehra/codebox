import { Difficulty, PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  await prisma.problem.upsert({
    where: { slug: 'two-sum' },
    update: {
      testCases: {
        updateMany: {
          where: { input: '4\\n2 7 11 15\\n9' },
          data: { input: '4\n2 7 11 15\n9' },
        },
      },
    },
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
      testCases: { create: [{ input: '4\n2 7 11 15\n9', expectedOut: '0 1', isHidden: false }] },
    },
  });
}
main().finally(() => prisma.$disconnect());

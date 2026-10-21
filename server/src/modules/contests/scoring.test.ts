import { describe, expect, it } from 'vitest';
import { scoreContestLeaderboard } from './scoring.js';

const joinedAt = new Date('2026-10-01T00:00:00.000Z');

describe('contest leaderboard scoring', () => {
  it('awards each contest problem once and ignores submissions outside the contest', () => {
    const leaderboard = scoreContestLeaderboard(
      [
        { userId: 'user-a', displayName: 'Aster', joinedAt },
        { userId: 'user-b', displayName: 'Birch', joinedAt },
      ],
      [
        { problemId: 'problem-a', points: 100 },
        { problemId: 'problem-b', points: 250 },
      ],
      [
        { userId: 'user-a', problemId: 'problem-a', acceptedAt: new Date('2026-10-05T10:00:00Z') },
        { userId: 'user-a', problemId: 'problem-a', acceptedAt: new Date('2026-10-05T10:01:00Z') },
        {
          userId: 'user-a',
          problemId: 'not-in-contest',
          acceptedAt: new Date('2026-10-05T10:02:00Z'),
        },
        { userId: 'user-b', problemId: 'problem-b', acceptedAt: new Date('2026-10-05T10:03:00Z') },
      ],
    );

    expect(leaderboard).toEqual([
      {
        rank: 1,
        displayName: 'Birch',
        score: 250,
        solvedCount: 1,
        lastSolvedAt: new Date('2026-10-05T10:03:00Z'),
      },
      {
        rank: 2,
        displayName: 'Aster',
        score: 100,
        solvedCount: 1,
        lastSolvedAt: new Date('2026-10-05T10:00:00Z'),
      },
    ]);
  });

  it('breaks equal-score ties by the earlier time the score was reached', () => {
    const leaderboard = scoreContestLeaderboard(
      [
        { userId: 'later', displayName: 'Later', joinedAt },
        { userId: 'earlier', displayName: 'Earlier', joinedAt },
        { userId: 'none', displayName: 'No solves', joinedAt },
      ],
      [{ problemId: 'problem-a', points: 100 }],
      [
        { userId: 'later', problemId: 'problem-a', acceptedAt: new Date('2026-10-05T10:02:00Z') },
        { userId: 'earlier', problemId: 'problem-a', acceptedAt: new Date('2026-10-05T10:01:00Z') },
      ],
    );

    expect(
      leaderboard.map(({ displayName, rank, score }) => ({ displayName, rank, score })),
    ).toEqual([
      { displayName: 'Earlier', rank: 1, score: 100 },
      { displayName: 'Later', rank: 2, score: 100 },
      { displayName: 'No solves', rank: 3, score: 0 },
    ]);
  });
});

export type ContestScoreProblem = { problemId: string; points: number };
export type ContestScoreParticipant = {
  userId: string;
  displayName: string;
  joinedAt: Date;
};
export type AcceptedContestSubmission = {
  userId: string;
  problemId: string;
  acceptedAt: Date;
};

export type ContestLeaderboardEntry = {
  rank: number;
  displayName: string;
  score: number;
  solvedCount: number;
  lastSolvedAt: Date | null;
};

export function scoreContestLeaderboard(
  participants: ContestScoreParticipant[],
  problems: ContestScoreProblem[],
  acceptedSubmissions: AcceptedContestSubmission[],
): ContestLeaderboardEntry[] {
  const pointsByProblem = new Map(problems.map(({ problemId, points }) => [problemId, points]));
  const solvesByUser = new Map<string, Map<string, Date>>();

  for (const submission of acceptedSubmissions) {
    if (!pointsByProblem.has(submission.problemId)) continue;

    let solves = solvesByUser.get(submission.userId);
    if (!solves) {
      solves = new Map();
      solvesByUser.set(submission.userId, solves);
    }

    const previousSolve = solves.get(submission.problemId);
    if (!previousSolve || submission.acceptedAt < previousSolve) {
      solves.set(submission.problemId, submission.acceptedAt);
    }
  }

  return participants
    .map((participant) => {
      const solves = solvesByUser.get(participant.userId) ?? new Map<string, Date>();
      const solvedAt = [...solves.values()];
      return {
        displayName: participant.displayName,
        score: [...solves.keys()].reduce(
          (total, problemId) => total + (pointsByProblem.get(problemId) ?? 0),
          0,
        ),
        solvedCount: solves.size,
        lastSolvedAt: solvedAt.length ? new Date(Math.max(...solvedAt.map(Number))) : null,
        joinedAt: participant.joinedAt,
      };
    })
    .sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      if (left.lastSolvedAt && right.lastSolvedAt) {
        const solveTimeDifference = left.lastSolvedAt.getTime() - right.lastSolvedAt.getTime();
        if (solveTimeDifference !== 0) return solveTimeDifference;
      } else if (left.lastSolvedAt || right.lastSolvedAt) {
        return left.lastSolvedAt ? -1 : 1;
      }
      const joinTimeDifference = left.joinedAt.getTime() - right.joinedAt.getTime();
      if (joinTimeDifference !== 0) return joinTimeDifference;
      return left.displayName.localeCompare(right.displayName);
    })
    .map((entry, index) => ({
      rank: index + 1,
      displayName: entry.displayName,
      score: entry.score,
      solvedCount: entry.solvedCount,
      lastSolvedAt: entry.lastSolvedAt,
    }));
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type ContestDetails, type ContestLeaderboardEntry } from '../services/api';

type LeaderboardResponse = {
  data: ContestLeaderboardEntry[];
  myRank: number | null;
  totalProblems: number;
};

type ApiError = { error?: { message?: string } };

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

export function ContestDetailsPage() {
  const { id } = useParams();
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState('');
  const contestQuery = useQuery({
    queryKey: ['contest', id],
    enabled: Boolean(id),
    queryFn: async () => (await api.get<{ data: ContestDetails }>(`/contests/${id}`)).data.data,
  });
  const leaderboardQuery = useQuery({
    queryKey: ['contest-leaderboard', id],
    enabled: Boolean(id),
    queryFn: async () => (await api.get<LeaderboardResponse>(`/contests/${id}/leaderboard`)).data,
    refetchInterval: contestQuery.data?.status === 'LIVE' ? 15_000 : false,
  });
  const joinContest = useMutation({
    mutationFn: async () =>
      api.post(
        `/contests/${id}/join`,
        displayName.trim() ? { displayName: displayName.trim() } : {},
      ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['contest', id] }),
        queryClient.invalidateQueries({ queryKey: ['contest-leaderboard', id] }),
      ]);
    },
  });

  if (contestQuery.isPending) return <p className="page-state">Loading contest…</p>;
  if (contestQuery.isError || !contestQuery.data) {
    return <p className="error page-state">Contest not found.</p>;
  }

  const contest = contestQuery.data;
  const isAuthenticated = Boolean(localStorage.getItem('token'));
  const joinError = axios.isAxiosError<ApiError>(joinContest.error)
    ? joinContest.error.response?.data?.error?.message
    : undefined;

  return (
    <section className="contest-detail-page">
      <Link className="text-link" to="/contests">
        ← All contests
      </Link>
      <div className="contest-heading">
        <div>
          <p className="eyebrow">CONTEST</p>
          <h1>{contest.title}</h1>
          <p>{contest.description}</p>
        </div>
        <span className={`contest-status ${contest.status.toLowerCase()}`}>
          {contest.status.toLowerCase()}
        </span>
      </div>

      <div className="contest-summary-grid">
        <div>
          <span>Starts</span>
          <strong>{formatDate(contest.startAt)}</strong>
        </div>
        <div>
          <span>Ends</span>
          <strong>{formatDate(contest.endAt)}</strong>
        </div>
        <div>
          <span>Participants</span>
          <strong>{contest.participantCount}</strong>
        </div>
        <div>
          <span>Problems</span>
          <strong>{contest.problems.length}</strong>
        </div>
      </div>

      {!contest.isParticipant && contest.status !== 'COMPLETED' && (
        <div className="contest-join-panel">
          {isAuthenticated ? (
            <>
              <label>
                Public display name
                <input
                  maxLength={24}
                  minLength={2}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="Optional; a private player tag will be generated"
                  value={displayName}
                />
              </label>
              <button
                className="button"
                disabled={joinContest.isPending}
                onClick={() => joinContest.mutate()}
              >
                {joinContest.isPending ? 'Joining…' : 'Join contest'}
              </button>
            </>
          ) : (
            <p>
              <Link className="text-link" to="/login">
                Log in
              </Link>{' '}
              to join this contest and submit solutions.
            </p>
          )}
          {joinError && (
            <p className="error" role="alert">
              {joinError}
            </p>
          )}
        </div>
      )}
      {contest.isParticipant && (
        <p className="contest-member-note">
          Joined as <strong>{contest.displayName}</strong>.{' '}
          {contest.status === 'LIVE'
            ? 'Your contest submissions count toward the standings.'
            : contest.status === 'UPCOMING'
              ? 'You can submit when the contest starts.'
              : 'The contest is over; the final standings are shown below.'}
        </p>
      )}

      <div className="contest-columns">
        <section className="contest-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">PROBLEM SET</p>
              <h2>Contest problems</h2>
            </div>
          </div>
          {contest.problems.length === 0 ? (
            <p className="muted">No published problems are available for this contest.</p>
          ) : (
            <div className="contest-problem-list">
              {contest.problems.map(({ points, problem }, index) => {
                const inContest = contest.isParticipant && contest.status === 'LIVE';
                const href = inContest
                  ? `/problems/${problem.id}?contestId=${contest.id}`
                  : `/problems/${problem.id}`;
                return (
                  <Link className="contest-problem-row" to={href} key={problem.id}>
                    <span className="contest-problem-index">{String.fromCharCode(65 + index)}</span>
                    <span className="contest-problem-name">
                      <strong>{problem.title}</strong>
                      <small>{problem.difficulty}</small>
                    </span>
                    <span className="contest-points">{points} pts</span>
                  </Link>
                );
              })}
            </div>
          )}
        </section>

        <section className="contest-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">STANDINGS</p>
              <h2>Leaderboard</h2>
            </div>
            <span className="muted">
              {leaderboardQuery.data?.totalProblems ?? contest.problems.length} problems
            </span>
          </div>
          {leaderboardQuery.isError && <p className="error">Standings could not be loaded.</p>}
          {leaderboardQuery.data?.myRank && (
            <p className="contest-member-note">
              Your current rank: <strong>#{leaderboardQuery.data.myRank}</strong>
            </p>
          )}
          {(leaderboardQuery.data?.data.length ?? 0) === 0 ? (
            <p className="muted">No joined participants yet. Be the first to take part.</p>
          ) : (
            <div className="leaderboard-table-wrap">
              <table className="leaderboard-table">
                <thead>
                  <tr>
                    <th>Rank</th>
                    <th>Participant</th>
                    <th>Score</th>
                    <th>Solved</th>
                  </tr>
                </thead>
                <tbody>
                  {leaderboardQuery.data?.data.map((entry) => (
                    <tr key={entry.rank}>
                      <td>{String(entry.rank).padStart(2, '0')}</td>
                      <td>{entry.displayName}</td>
                      <td>
                        <strong>{entry.score}</strong>
                      </td>
                      <td>{entry.solvedCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
      <p className="contest-scoring-note">
        Each problem scores once on its first accepted contest submission. Ties go to the
        participant who reached their score earlier; failed submissions carry no penalty.
      </p>
    </section>
  );
}

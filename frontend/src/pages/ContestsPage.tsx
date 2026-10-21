import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type ContestSummary } from '../services/api';

export function ContestsPage() {
  const { data, isPending, isError } = useQuery({
    queryKey: ['contests'],
    queryFn: async () => (await api.get<{ data: ContestSummary[] }>('/contests')).data.data,
  });

  return (
    <section>
      <div className="page-heading">
        <p className="eyebrow">CONTESTS</p>
        <h1>Think under a timer.</h1>
        <p>Join a scheduled contest, solve its problems, and follow the live standings.</p>
      </div>
      {isPending && <p>Loading contests…</p>}
      {isError && <p className="error">Contests are unavailable. Try again shortly.</p>}
      {data?.length === 0 && <p className="page-state">No published contests yet.</p>}
      <div className="contest-grid">
        {data?.map((contest) => (
          <Link className="contest-card" to={`/contests/${contest.slug}`} key={contest.id}>
            <div className="contest-card-topline">
              <span className={`contest-status ${contest.status.toLowerCase()}`}>
                {contest.status.toLowerCase()}
              </span>
              <span>{contest.problemCount} problems</span>
            </div>
            <h2>{contest.title}</h2>
            <p>{contest.description}</p>
            <div className="contest-card-footer">
              <span>{new Date(contest.startAt).toLocaleString()}</span>
              <span>{contest.participantCount} joined</span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

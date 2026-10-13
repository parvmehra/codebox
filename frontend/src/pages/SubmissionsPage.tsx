import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type SubmissionSummary } from '../services/api';

type SubmissionPage = { data: SubmissionSummary[]; nextCursor: string | null };

export function SubmissionsPage() {
  const isAuthenticated = Boolean(localStorage.getItem('token'));
  const query = useInfiniteQuery({
    queryKey: ['submissions'],
    enabled: isAuthenticated,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      (
        await api.get<SubmissionPage>('/submissions', {
          params: { limit: 20, ...(pageParam ? { cursor: pageParam } : {}) },
        })
      ).data,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  if (!isAuthenticated) {
    return (
      <section className="page-state">
        <p>Log in to see your submission history.</p>
        <Link className="button" to="/login">Log in</Link>
      </section>
    );
  }
  if (query.isPending) return <p className="page-state">Loading submissions…</p>;
  if (query.isError) return <p className="error page-state">Submission history is unavailable.</p>;

  const submissions = query.data.pages.flatMap((page) => page.data);

  return (
    <section>
      <div className="page-heading">
        <p className="eyebrow">YOUR WORK</p>
        <h1>Submissions</h1>
        <p>Track the status and results of your recent solutions.</p>
      </div>

      {submissions.length === 0 ? (
        <div className="empty-state">
          <h2>No submissions yet</h2>
          <p>Choose a problem and send your first solution.</p>
          <Link className="button" to="/problems">Browse problems</Link>
        </div>
      ) : (
        <div className="submission-list">
          {submissions.map((submission) => (
            <Link className="submission-row" key={submission.id} to={`/submissions/${submission.id}`}>
              <div>
                <h2>{submission.problem.title}</h2>
                <p>{submission.language} · {new Date(submission.createdAt).toLocaleString()}</p>
              </div>
              <span className={`status-badge ${submission.status.toLowerCase().replaceAll('_', '-')}`}>
                {submission.status.replaceAll('_', ' ')}
              </span>
            </Link>
          ))}
        </div>
      )}

      {query.hasNextPage && (
        <button className="button load-more" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
          {query.isFetchingNextPage ? 'Loading…' : 'Load older submissions'}
        </button>
      )}
    </section>
  );
}

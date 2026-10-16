import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, type SubmissionDetails, type SubmissionStatus } from '../services/api';
import { useSubmissionRealtime } from '../hooks/useSubmissionRealtime';

const terminalStatuses = new Set<SubmissionStatus>([
  'ACCEPTED',
  'WRONG_ANSWER',
  'TIME_LIMIT_EXCEEDED',
  'MEMORY_LIMIT_EXCEEDED',
  'COMPILATION_ERROR',
  'RUNTIME_ERROR',
  'SYSTEM_ERROR',
  'CANCELLED',
]);

const statusDescriptions: Record<SubmissionStatus, string> = {
  QUEUED: 'Your submission is waiting for a worker to pick it up.',
  ASSIGNED: 'A worker has accepted this submission.',
  STARTING: 'The worker is preparing an isolated environment.',
  COMPILING: 'The worker is compiling your source code.',
  RUNNING: 'Your solution is being checked against the test cases.',
  ACCEPTED: 'All test cases passed.',
  WRONG_ANSWER: 'The output did not match the expected result.',
  TIME_LIMIT_EXCEEDED: 'The solution exceeded its time limit.',
  MEMORY_LIMIT_EXCEEDED: 'The solution exceeded its memory limit.',
  COMPILATION_ERROR: 'The source code could not be compiled.',
  RUNTIME_ERROR: 'The program stopped with a runtime error.',
  SYSTEM_ERROR: 'The platform could not process this submission.',
  CANCELLED: 'This submission was cancelled.',
};

export function SubmissionDetailsPage() {
  const { id } = useParams();
  const realtime = useSubmissionRealtime(id);
  const { data, isPending, isError } = useQuery({
    queryKey: ['submission', id],
    enabled: Boolean(id && localStorage.getItem('token')),
    queryFn: async () =>
      (await api.get<{ data: SubmissionDetails }>(`/submissions/${id}`)).data.data,
    refetchInterval: (query) => {
      if (query.state.status === 'error') return false;
      const status = query.state.data?.status;
      return status && terminalStatuses.has(status) ? false : realtime === 'live' ? 15_000 : 2_000;
    },
  });

  if (!localStorage.getItem('token')) {
    return (
      <section className="page-state">
        <p>Log in to view this submission.</p>
        <Link className="button" to="/login">
          Log in
        </Link>
      </section>
    );
  }
  if (isPending) return <p className="page-state">Loading submission…</p>;
  if (isError || !data) return <p className="error page-state">Submission not found.</p>;

  return (
    <section className="submission-detail-page">
      <Link className="text-link" to="/submissions">
        ← My submissions
      </Link>
      <div className="submission-detail-heading">
        <div>
          <p className="eyebrow">SUBMISSION</p>
          <h1>{data.problem.title}</h1>
          <p className="submission-meta">
            {data.language} · {new Date(data.createdAt).toLocaleString()}
          </p>
        </div>
        <span className={`status-badge ${data.status.toLowerCase().replaceAll('_', '-')}`}>
          {data.status.replaceAll('_', ' ')}
        </span>
      </div>

      <div className="status-panel">
        <span className="status-indicator" />
        <div className="status-panel-copy">
          <p>{statusDescriptions[data.status]}</p>
          <span className={`realtime-connection ${realtime}`}>
            <i />
            {realtime === 'live'
              ? 'Live updates connected'
              : realtime === 'reconnecting'
                ? 'Reconnecting · checking status periodically'
                : 'Checking status periodically'}
          </span>
        </div>
      </div>
      {data.status === 'RUNNING' && (
        <p className="test-progress-summary" aria-live="polite">
          {data.testResults.length === 0
            ? 'Waiting for the first test result…'
            : `${data.testResults.length} ${data.testResults.length === 1 ? 'test' : 'tests'} checked so far`}
        </p>
      )}
      {data.errorMessage && <p className="error execution-error">{data.errorMessage}</p>}
      {data.executionTimeMs !== null && (
        <p className="execution-metrics">
          Runtime: {data.executionTimeMs} ms
          {data.memoryUsedKb !== null && ` · Memory: ${data.memoryUsedKb} KB`}
        </p>
      )}
      {data.testResults.length > 0 && (
        <section className="test-results">
          <div className="test-results-heading">
            <h2>Test results</h2>
            <span>
              {data.testResults.length} {data.testResults.length === 1 ? 'test' : 'tests'} checked
            </span>
          </div>
          <div className="test-results-list">
            {data.testResults.map((result) => (
              <div className="test-result-row" key={result.testIndex}>
                <span>Test {result.testIndex}</span>
                <span
                  className={`test-result-status ${result.status.toLowerCase().replaceAll('_', '-')}`}
                >
                  {result.status.replaceAll('_', ' ')}
                </span>
                {result.executionTimeMs !== null && <span>{result.executionTimeMs} ms</span>}
                {result.errorMessage && <p>{result.errorMessage}</p>}
              </div>
            ))}
          </div>
        </section>
      )}
      <section className="source-panel">
        <h2>Submitted source</h2>
        <pre>{data.sourceCode}</pre>
      </section>
    </section>
  );
}

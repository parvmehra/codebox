import { useQuery } from '@tanstack/react-query';
import { api, type WorkerStatus } from '../services/api';

export function WorkerStatusPage() {
  const query = useQuery({
    queryKey: ['workers', 'status'],
    queryFn: async () => (await api.get<{ data: WorkerStatus }>('/workers/status')).data.data,
    refetchInterval: 5_000,
  });

  if (query.isPending) return <p className="page-state">Checking worker status…</p>;
  if (query.isError || !query.data) {
    return <p className="error page-state">Worker status is unavailable.</p>;
  }

  const online = query.data.status === 'online';

  return (
    <section className="worker-status-page">
      <div className="page-heading">
        <p className="eyebrow">PLATFORM HEALTH</p>
        <h1>Worker status</h1>
        <p>
          Heartbeat status updates every five seconds. A worker is considered offline when its
          heartbeat is stale.
        </p>
      </div>

      <article className="worker-status-card" aria-live="polite">
        <div className="worker-status-heading">
          <div>
            <p className="eyebrow">EXECUTION SERVICE</p>
            <h2>{online ? 'Ready to process submissions' : 'No active worker detected'}</h2>
          </div>
          <span className={`worker-status-indicator ${online ? 'online' : 'offline'}`}>
            <i /> {online ? 'ONLINE' : 'OFFLINE'}
          </span>
        </div>
        <dl className="worker-status-metrics">
          <div>
            <dt>Active workers</dt>
            <dd>{query.data.workerCount}</dd>
          </div>
          <div>
            <dt>Running jobs</dt>
            <dd>{query.data.activeJobs}</dd>
          </div>
          <div>
            <dt>Last heartbeat</dt>
            <dd>
              {query.data.lastHeartbeatAt
                ? new Date(query.data.lastHeartbeatAt).toLocaleTimeString()
                : 'Not received yet'}
            </dd>
          </div>
        </dl>
      </article>
      <p className="worker-status-note">
        This view uses in-memory heartbeats. It resets when the API restarts; persistent worker
        records are planned for the reliability phase.
      </p>
    </section>
  );
}

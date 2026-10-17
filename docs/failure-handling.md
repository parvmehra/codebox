# Failure handling

## Delivery and retry policy

- The API publishes persistent jobs to a durable RabbitMQ queue and waits for a publisher confirmation.
- A worker claims a queued submission with a conditional database update. The update increments its attempt count and assigns a unique lease token and expiry.
- Transient worker or persistence failures release a still-owned lease and publish a copy to the durable retry queue. The original delivery is acknowledged only after RabbitMQ confirms that copy.
- The retry queue delays a delivery for five seconds before dead-lettering it back to the execution queue. A submission receives at most three execution attempts total.
- Invalid messages and exhausted jobs are copied to the durable `submissions.dead` queue with a reason header; the original is acknowledged only after the dead-letter copy is confirmed.
- PostgreSQL is authoritative for claims and results. Duplicate messages can create another delivery but cannot claim an already active or terminal submission. Each successful claim uses a new, unique execution attempt number.
- If a retryable failure can be saved, the submission returns to `QUEUED`. After the final attempt, it becomes `SYSTEM_ERROR`. If the database is unavailable during finalization, the message is preserved in the dead-letter queue for operator recovery.

## Leases and stale-job recovery

The worker owns a 60-second lease while processing a submission and renews it in its persisted heartbeat. The API checks expired leases every 15 seconds. It closes an incomplete execution record, then either queues a new attempt or marks the submission `SYSTEM_ERROR` after the three-attempt budget is used. Recovered jobs are republished through a database-backed dispatch flag so a broker outage does not lose the recovery request.

Worker snapshots and heartbeat history are stored in PostgreSQL. The status endpoint counts a worker as online only when its last heartbeat is no more than 45 seconds old. Heartbeat history is retained for seven days.

## Cancellation and shutdown

Users can cancel their own queued or active submissions. The API changes the database status to `CANCELLED` first and then signals workers over a transient RabbitMQ control exchange. Workers also check the database for cancellation, so a missed control event does not leave an execution running indefinitely. Docker commands receive an abort signal; cancellation kills the isolated container and its temporary resources are removed in the `finally` cleanup.

On worker shutdown, the consumer stops accepting new work and waits up to 18 seconds for active work. Remaining work is aborted, returned to the queue through the confirmed retry path, and the worker records an offline heartbeat. Compose allows 30 seconds before stopping the container. Unacknowledged deliveries are requeued by RabbitMQ if the process exits before completing shutdown.

## Remaining limitations

- The dead-letter queue is durable and inspectable, but there is no admin UI or automated replay workflow yet.
- Heartbeat history is operational data, not an audit guarantee. A database outage can interrupt its retention cleanup and heartbeat writes.
- Docker provides useful educational isolation, not a guarantee against every hostile-code escape. See [sandbox security](sandbox-security.md).
- Socket.IO updates remain transient; PostgreSQL-backed REST reads and polling are the recovery path for missed events.

## Learning notes

- **Problem solved:** bounded retries cover transient worker and database failures without creating infinite poison-message loops; leases recover work after a process disappears.
- **Why this design:** RabbitMQ handles delivery and delay, while PostgreSQL remains the source of truth for attempts, ownership, cancellation, and results. A lease token fences off an expired worker after another attempt has taken ownership.
- **Important failure cases:** if a worker crashes, the message may be redelivered before its lease expires; the duplicate is acknowledged and the recovery loop republishes the job when the lease becomes stale. If a broker confirm is lost, duplicate delivery is safe because the database claim is conditional.
- **Interview question — Why acknowledge after retry publishing?** Confirming the replacement first means RabbitMQ never removes the only known copy before the next attempt or dead-letter copy is durable.
- **Interview question — Why keep a lease token if attempt count is stored?** Attempt count distinguishes historical executions; the random lease token prevents an old worker from updating the row after recovery assigns a new attempt.

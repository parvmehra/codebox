# Failure handling

## Current behavior

- The API publishes persistent jobs to a durable RabbitMQ queue and waits for a publisher confirmation.
- If publishing fails, the saved submission becomes `SYSTEM_ERROR` and the API returns a `503` with the submission ID.
- The worker acknowledges a valid job only after it has persisted the processing outcome.
- If the worker cannot persist its outcome, it requeues the unacknowledged message.
- Invalid JSON or invalid job payloads are logged and acknowledged to avoid a poison-message loop.
- Compilation failures, wrong answers, timeouts, memory-limit events, and runtime failures have separate outcomes.
- Docker setup failures are logged internally and returned as a generic `SYSTEM_ERROR` message.

## Not implemented yet

The current worker does not have a bounded retry counter, dead-letter queue, worker heartbeat, stale-worker detector, or cancellation protocol. A process crash after it claims a submission can leave that row in an in-progress status; a re-delivered message will not start a duplicate execution. The reliability phase will add a lease/heartbeat model and a bounded retry policy before claiming recovery is complete.

## Learning notes

- **Problem solved:** durable delivery and explicit terminal states make failures visible rather than leaving requests waiting indefinitely.
- **Why this design:** RabbitMQ publisher confirms and manual worker acknowledgements are a small foundation for at-least-once delivery.
- **Important failure cases:** broker outage, duplicate delivery, worker crash, database outage, and Docker outage are distinct and need different recovery paths.
- **Interview question — Why acknowledge after persistence?** If the worker acknowledges first and then crashes, the result can be lost while the broker removes the message.
- **Interview question — Is the current retry policy complete?** No. Database-related redelivery exists, but bounded retries, dead-letter handling, and crash recovery are still planned.

# Worker design

The worker is a separate Node.js process. It consumes the existing durable `submissions.execute` queue with a prefetch of one message per worker. Multiple worker containers can be added later without changing the API contract.

## Language profiles

`server/src/worker/language-profile.ts` defines the `LanguageProfile` abstraction. The Java 21 profile owns the source filename, compiler command, run command, image, time limit, memory limit, process limit, source limit, and output limit. Python, C++, and Node.js are intentionally not registered yet.

## Claim and acknowledgement

The worker changes `QUEUED` to `ASSIGNED` with a conditional database update. Duplicate messages for rows that are already assigned or terminal do not start a second execution. After the worker persists the final status and execution results, it acknowledges the RabbitMQ message. If persistence fails, it rejects with requeue so the broker can redeliver.

The Docker socket is mounted only in the trusted worker container. The worker uses the Docker CLI to create a container and copy the source file into it. The execution container receives no socket, credentials, network, or host bind mount.

On shutdown, the worker cancels its RabbitMQ consumer, waits for the current delivery to finish, then closes RabbitMQ and PostgreSQL connections. Compose allows 30 seconds for that shutdown before forcing the container to stop.

## Learning notes

- **Problem solved:** queue consumers absorb execution work asynchronously and can scale independently of request handling.
- **Why this design:** a single worker process and a small profile object are straightforward to test and explain; language commands do not spread through queue logic.
- **Important failure cases:** a worker crash after claiming a submission can leave it in an in-progress state. Heartbeats and stale-worker recovery are planned for the reliability phase. Current duplicate handling is not a complete recovery protocol.
- **Interview question — Why prefetch one?** It bounds the number of unacknowledged jobs held by each worker and keeps the initial scheduling behavior simple.
- **Interview question — Why use a database conditional update to claim a job?** It makes the state change atomic and prevents two workers from both claiming the same queued row in the normal case.

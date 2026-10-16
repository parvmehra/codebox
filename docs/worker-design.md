# Worker design

The worker is a separate Node.js process. It consumes the existing durable `submissions.execute` queue with a prefetch of one message per worker. Multiple worker containers can be added later without changing the API contract.

## Language profiles

`server/src/worker/language-profile.ts` defines the `LanguageProfile` abstraction. Each profile owns its source filename, version-specific runtime image tag, compile or syntax-check command, run command, time limit, memory limit, process limit, source limit, and output limit.

| Language    | Runtime image                  | Compile or syntax check |
| ----------- | ------------------------------ | ----------------------- |
| Java 21     | `eclipse-temurin:21-jdk-jammy` | `javac`                 |
| Python 3.12 | `python:3.12.15-slim-bookworm` | `py_compile`            |
| C++23       | `gcc:14.3-bookworm`            | `g++ -std=c++23`        |
| Node.js 22  | `node:22.23.2-bookworm-slim`   | `node --check`          |

The worker checks for all four images at startup and pulls missing images in parallel. Interpreted languages still pass through the same `COMPILING` state for syntax validation, then execute through their runtime. C++ compiles its binary to a private executable tmpfs because the source workspace is mounted `noexec`.

## Claim and acknowledgement

The worker changes `QUEUED` to `ASSIGNED` with a conditional database update. Duplicate messages for rows that are already assigned or terminal do not start a second execution. After the worker persists the final status and execution results, it acknowledges the RabbitMQ message. If persistence fails, it rejects with requeue so the broker can redeliver.

The Docker socket is mounted only in the trusted worker container. The worker uses the Docker CLI to create a container and streams source through standard input into its writable `/workspace` tmpfs. The execution container receives no socket, credentials, network, or host bind mount.

On shutdown, the worker cancels its RabbitMQ consumer, waits for the current delivery to finish, then closes RabbitMQ and PostgreSQL connections. Compose allows 30 seconds for that shutdown before forcing the container to stop.

## Real-time updates and worker status

After a status or test-result write succeeds, the worker publishes a compact event to the non-durable `submissions.events` topic exchange. The API owns a temporary, auto-delete queue and forwards submission events to the user's authenticated Socket.IO room. The event payload omits source, test input, and expected output. The API publishes `submission:queued` before sending the durable job, preserving lifecycle order.

The worker reports its active job count every 15 seconds. The API keeps these heartbeats in memory and reports workers offline after 45 seconds without an update. The `/status` page polls the public worker-status endpoint every five seconds. Heartbeats are not persisted yet; durable worker records and stale-worker recovery belong to the reliability phase. If an event is missed, the submission details page refreshes through REST polling.

## Learning notes

- **Problem solved:** queue consumers absorb execution work asynchronously and can scale independently of request handling.
- **Why this design:** a single worker process and a small profile object are straightforward to test and explain; language commands do not spread through queue logic.
- **Why C++ has a second tmpfs:** the source workspace stays `noexec`; the compiler writes its output to a separate, bounded executable mount that is removed with the container.
- **Important failure cases:** a worker crash after claiming a submission can leave it in an in-progress state. The basic heartbeat can show the worker offline, but does not recover the submission. Current duplicate handling is not a complete recovery protocol.
- **Interview question — Why prefetch one?** It bounds the number of unacknowledged jobs held by each worker and keeps the initial scheduling behavior simple.
- **Interview question — Why use a database conditional update to claim a job?** It makes the state change atomic and prevents two workers from both claiming the same queued row in the normal case.

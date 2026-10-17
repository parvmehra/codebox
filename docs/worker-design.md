# Worker design

The worker is a separate Node.js process. `WORKER_LANGUAGES` lists the languages it can execute; it consumes a durable queue shared only with workers advertising the same capability set. Multiple worker groups can run different language images without changing the API contract. Each worker queue has a prefetch of one.

## Language profiles

`server/src/worker/language-profile.ts` defines the `LanguageProfile` abstraction. Each profile owns its source filename, versioned runtime image, compile or syntax-check command, run command, time limit, memory limit, process limit, source limit, and output limit.

| Language    | Runtime image                  | Compile or syntax check |
| ----------- | ------------------------------ | ----------------------- |
| Java 21     | `eclipse-temurin:21-jdk-jammy` | `javac`                 |
| Python 3.12 | `python:3.12.15-slim-bookworm` | `py_compile`            |
| C++23       | `gcc:14.3-bookworm`            | `g++ -std=c++23`        |
| Node.js 22  | `node:22.23.2-bookworm-slim`   | `node --check`          |

The worker checks all four images at startup and pulls missing images in parallel. Interpreted languages also pass through `COMPILING` for syntax validation. C++ writes its binary to a private executable tmpfs because the source workspace is mounted `noexec`.

## Claim, lease, and acknowledgement

The worker conditionally changes `QUEUED` to `ASSIGNED`, increments `attemptCount`, and writes a random lease token with a 60-second expiry. The database claim is the idempotency gate: a duplicate delivery cannot claim an active or terminal submission. The attempt count supplies a unique `Execution.attemptNumber`.

The worker renews leases and persists its own heartbeat every 15 seconds. It acknowledges a normal delivery only after the final result is persisted. On a retryable failure, it returns a still-owned submission to `QUEUED`, publishes a durable copy to the five-second retry queue, waits for publisher confirmation, then acknowledges the original. Three execution attempts are allowed. Invalid or exhausted messages go to the durable dead-letter queue.

The API recovery loop finds expired leases every 15 seconds. It fences off the former attempt by matching the lease token, closes the incomplete execution record, and either dispatches a new attempt or marks the submission `SYSTEM_ERROR` when its retry budget is used.

## Cancellation and shutdown

The API persists a user cancellation before broadcasting a transient control message. Each worker has a short-lived control queue; the matching active job receives an `AbortSignal`. Workers also poll the database for cancelled active submissions, so the database remains authoritative if a control message is missed. The Docker CLI receives the same abort signal, stops the execution container, and cleanup removes the container in a `finally` block.

During shutdown, the worker cancels both consumers, waits up to 18 seconds for active jobs, then aborts remaining work and routes it through the retry queue. It records an offline heartbeat before closing RabbitMQ and PostgreSQL. The compose service allows 30 seconds for the worker to exit.

## Real-time updates and worker status

After each status or test-result write, the worker publishes a compact event to the non-durable `submissions.events` topic exchange. The API owns a temporary queue and forwards submission events only to the authenticated owner's Socket.IO room. Event payloads omit source, test input, and expected output. The API publishes `submission:queued` before sending the durable job to preserve lifecycle order.

Worker snapshots and append-only heartbeat records are persisted in PostgreSQL. The `/status` page counts workers online when their heartbeat is no older than 45 seconds and polls every five seconds. Heartbeat history is retained for seven days. If a real-time event is missed, the submission detail page refreshes through REST polling.

## Scheduling

The API scheduler consumes durable ingress and routes work only to a capability group that includes the submission's language. It reads the RabbitMQ depth of each eligible worker-group queue and combines it with the group's average active-job count; the lowest load wins. Workers sharing a capability set use one queue and RabbitMQ distributes messages to their consumers.

Set `SCHEDULER_STRATEGY=FIFO` for the default arrival order, or `PRIORITY` to honor a submission priority from 0 through 10. Only admins can set a nonzero priority through the submission API. `WORKER_LANGUAGES` is a comma-separated list such as `JAVA,PYTHON`; it defaults to all supported languages. If no live matching worker is available, a confirmed copy waits 15 seconds before the scheduler tries again.

## Learning notes

- **Problem solved:** queue consumers absorb execution work asynchronously and survive duplicate delivery, transient persistence errors, and worker crashes.
- **Why this design:** the database lease is a small, explainable fencing mechanism. RabbitMQ handles delivery and retry timing, while PostgreSQL remains authoritative for job ownership and results.
- **Why C++ has a second tmpfs:** the source workspace stays `noexec`; the compiler writes its output to a separate, bounded executable mount that is removed with the container.
- **Important failure cases:** a stale worker can continue briefly after losing its lease, but its conditional writes fail; cancelled and expired leases prevent its result from replacing a newer state.
- **Scheduler failure cases:** ingress and capability queues are durable; an unacknowledged ingress delivery returns to RabbitMQ if the API exits. Jobs wait and retry assignment when no fresh capable worker is registered.
- **Interview question — Why prefetch one?** It bounds unacknowledged work and makes per-worker active-job reporting straightforward.
- **Interview question — How are retries idempotent?** A conditional `QUEUED` claim and a unique execution attempt number prevent two deliveries from creating the same active attempt.
- **Interview question — How does the scheduler avoid sending Python to a Java-only worker?** Workers advertise a capability set in their heartbeat and consume only the durable queue named for that exact set; the scheduler selects only matching groups.
- **Interview question — Why combine queue depth with active jobs?** Queue depth measures waiting work while heartbeat snapshots estimate work already running; together they distinguish equally capable but differently loaded worker groups.

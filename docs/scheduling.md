# Scheduling

The API scheduler separates job submission from worker selection. The HTTP request saves a queued submission and publishes a persistent message to RabbitMQ ingress. The scheduler consumes that message, finds online workers that support its language, then forwards a confirmed copy to a queue shared by that exact worker capability set.

```text
API ──confirmed──► submissions.scheduler
                         │
                         ├── fresh worker capabilities
                         ├── RabbitMQ queue depths
                         └── choose the least-loaded matching group
                                      │
                                      ▼
                      submissions.worker.<capabilities>
                                      │
                                      ▼
                           matching worker process
```

## Strategies

`SCHEDULER_STRATEGY` accepts `FIFO` or `PRIORITY` and defaults to `FIFO`.

- **FIFO:** every RabbitMQ message uses priority 0, so work in a capability queue follows arrival order.
- **Priority:** the scheduler uses a submission's stored priority from 0 to 10. RabbitMQ's bounded priority queues deliver higher-priority waiting work first; messages with equal priority remain FIFO. A running submission is never preempted.

Only an admin can submit a nonzero priority through `POST /api/submissions`. Regular users receive the same FIFO service without a priority override.

## Capability matching and load

Set `WORKER_LANGUAGES` to a comma-separated list such as `JAVA,PYTHON`. The default is `JAVA,PYTHON,CPP,NODEJS`. A worker persists this list in its heartbeat and listens only to the durable queue named for that sorted capability set. Workers with identical capability sets share a queue, allowing RabbitMQ to distribute work among their consumers.

For a submission, the scheduler ignores workers with stale heartbeats, workers that do not support its language, and queues with no consumers. It declares each durable capability queue before reading its depth, so a removed queue can be recreated safely; a queue receives no work until a compatible worker consumes from it. It groups eligible workers by capability set and scores each group as:

```text
queue load = waiting RabbitMQ messages + average active jobs per worker
```

The group with the smallest load receives the job. This lets a Java job prefer an idle Java-only group over a busy all-language group while still allowing Java workers to handle the job when they have more capacity.

If no live capable worker exists, the scheduler publishes a confirmed copy to `submissions.scheduler.wait`. RabbitMQ returns it to ingress after 15 seconds, so the job remains queued while worker capacity comes online. A worker whose configuration never includes the requested language will not be selected; check the worker logs and `WORKER_LANGUAGES` setting in that case.

## Delivery and failure behavior

The new scheduler ingress, wait queue, and capability queues are durable. The scheduler acknowledges an ingress delivery only after the target or wait-queue copy is publisher-confirmed. If it exits before the confirmation, RabbitMQ requeues the unacknowledged ingress message. Workers still use the database claim and lease token as the idempotency gate, so a duplicate routed copy cannot start a second active attempt.

The API continues consuming the previous `submissions.execute` ingress while existing messages drain. Retries use a separate delayed queue that dead-letters back to the new scheduler ingress, so each retry is matched against current worker capabilities and queue depth.

The scheduler algorithm is in `server/src/queue/scheduler.ts`; `scheduler-service.ts` handles RabbitMQ and database reads. Unit tests cover FIFO and priority values, capability filtering, queue-depth and active-job load, and deterministic group selection.

## Learning notes

- **Problem solved:** workers may support different languages and have different backlogs, so a single undifferentiated execution queue can send work to the wrong process or overload one group.
- **Why RabbitMQ priority queues:** they provide simple bounded ordering with no Redis or custom job database. FIFO remains the default and equal priorities preserve order.
- **Data flow:** the API stores priority and capabilities in PostgreSQL, publishes to ingress, and the scheduler uses fresh worker snapshots plus broker queue depth to choose a matching durable group queue.
- **Important failure cases:** a missing worker causes delayed reassignment; a queue without a live consumer is excluded; duplicate forwarding is safe because the database claim is conditional.
- **Interview question — Why route to a capability group instead of a specific worker?** Workers with identical capabilities share a RabbitMQ queue, which avoids keeping fragile per-process queue assignments; RabbitMQ distributes messages among consumers in that group.
- **Interview question — What does queue depth add to active-job heartbeats?** The heartbeat counts work already running, while RabbitMQ reports waiting work. Combining them helps choose between otherwise eligible worker groups.

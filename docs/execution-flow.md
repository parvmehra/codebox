# Execution flow

The worker supports Java 21, Python 3.12, C++23, and Node.js 22. The API accepts only languages registered in `LanguageProfile`.

## Submission lifecycle

```text
QUEUED → ASSIGNED → STARTING → COMPILING → RUNNING → ACCEPTED
                                      │          ├─ WRONG_ANSWER
                                      │          ├─ TIME_LIMIT_EXCEEDED
                                      │          ├─ MEMORY_LIMIT_EXCEEDED
                                      │          └─ RUNTIME_ERROR
                                      ├─ COMPILATION_ERROR
                                      └─ SYSTEM_ERROR
```

The transition table is enforced by `server/src/modules/submissions/state-machine.ts`. The worker uses a conditional update for each transition so an unexpected state change cannot silently overwrite the row.

## Worker steps

1. The API scheduler consumes a durable ingress message, matches its language to fresh worker capabilities, and selects the least-loaded eligible capability queue.
2. A matching worker consumes a RabbitMQ message containing the submission ID.
3. Claim the submission only while its status is `QUEUED`, increment its attempt count, and acquire a time-limited lease.
4. Resolve the language profile and load the problem's test cases.
5. Create an execution record with the profile's runtime version, image, and configured resource limits.
6. Create a fresh container and stream the source into its private `/workspace` tmpfs.
7. Run the profile's compile or syntax-check command. C++ writes its compiled binary to a separate executable tmpfs.
8. Run the program once per test case, passing each input through standard input.
9. Normalize line endings and whitespace before comparing output.
10. Persist each verdict, publish test progress, and publish the final submission state; remove the container, then acknowledge the message.

Transient worker or database failures release the current lease and use a confirmed RabbitMQ copy in the delayed retry queue. Three execution attempts are allowed; invalid or exhausted messages go to the durable dead-letter queue. If a process disappears, the API recovery loop resets an expired lease and dispatches a new attempt, unless the attempt budget is exhausted.

The API forwards queued, lifecycle, test-progress, and final events from a temporary RabbitMQ topic queue to the authenticated owner's Socket.IO room. The browser invalidates its REST query on each matching event and polls periodically as a reconnect fallback. The worker persists heartbeat snapshots and history every 15 seconds; the status endpoint treats a heartbeat as stale after 45 seconds.

Users can cancel their own queued or running submissions. The API commits `CANCELLED` in PostgreSQL, emits an owner-only status event, and signals workers to abort the Docker process. Workers also poll the database so cancellation survives a missed transient control event.

The result API returns test number, verdict, runtime, compiler diagnostics, and a generic runtime error. Socket.IO events contain only status and per-test verdict metadata. Neither interface returns test input, expected output, or submitted-program stderr, including for hidden cases.

## Learning notes

- **Problem solved:** explicit states make progress and failure outcomes visible to both the UI and operators.
- **Why this design:** profiles isolate language-specific commands and limits, while the API scheduler routes by capability and load and the worker owns execution and result persistence. Socket.IO gives the UI prompt updates, while REST stays the source for current state.
- **Scheduling:** the API selects a language-compatible worker group using fresh capability heartbeats and RabbitMQ queue depth; [scheduling](scheduling.md) documents FIFO, priority, and load scoring.
- **Important failure cases:** compile errors become `COMPILATION_ERROR`; program failures become runtime verdicts; Docker or database failures become `SYSTEM_ERROR` when that state can be persisted.
- **Interview question — Why compare normalized output?** It ignores harmless whitespace differences while preserving token order and values.
- **Interview question — Why persist per-test results?** A final verdict alone hides where evaluation stopped and cannot support a useful result page.

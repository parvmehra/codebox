# Database design

PostgreSQL stores durable user, problem, test-case, submission, execution, and test-result data. Prisma defines the schema and checked-in migrations evolve it.

## Execution entities

- `Submission` stores the submitted source, current lifecycle status, bounded scheduling priority, and execution attempts.
- `Execution` stores one worker attempt, language version, Docker image tag, immutable image digest and image ID, the source SHA-256, a JSON snapshot of the language profile, resource limits, timestamps, and aggregate runtime. `(submissionId, attemptNumber)` is unique.
- `TestCase.version` identifies the current revision. Each edit appends an immutable `TestCaseVersion`; the API requires the expected current version so stale admin edits return a conflict instead of overwriting a newer revision.
- `ExecutionTestCase` pins each execution's ordered test set to exact test-case versions. Re-runs read these references, even after an administrator changes the current test cases.
- `ExecutionTestResult` stores a one-based test index, verdict, runtime, and optional error details. It links to the execution's pinned test case without copying inputs or expected outputs into the user-facing result payload.
- `Worker` stores the latest durable status, language capabilities, active-job count, and heartbeat timestamp for each worker process. The API derives online status from the 45-second freshness window.
- `WorkerHeartbeat` keeps timestamped status, capabilities, and active-job snapshots for seven days so worker health remains inspectable after an API restart.
- `Submission` tracks execution attempts, the current worker and lease token, the lease expiry, and whether a recovered job still needs dispatch.
- A re-run creates a new `Submission` linked to its source `Execution`. The original submission and its results are not reset or replaced.

The submission API returns all execution metadata and the latest attempt's verdicts to the owning user. Test inputs and expected outputs remain private; execution snapshots reference immutable versions instead of returning their contents.

## Learning notes

- **Problem solved:** source, runtime, image, and test versions remain identifiable after the worker exits, while a new run leaves the original result intact.
- **Why PostgreSQL:** the platform needs relational ownership, durable state transitions, foreign keys, and queryable submission history.
- **Important failure cases:** a worker can fail before writing its final status, a stale edit can race with a newer test-case version, or duplicate delivery can race. Leases recover jobs; version checks reject stale edits; execution snapshots keep historical tests pinned.
- **Scheduling data:** the submission's priority and each worker's advertised capabilities survive restarts, so the scheduler can make repeatable choices from database state.
- **Interview question — How does a re-run preserve the first result?** It creates another submission and execution linked to the original execution, rather than changing the original submission status or rows.
- **Interview question — Why keep a test-case revision table?** Updating the current test case must not silently change which inputs and expected values an older execution used.
- **Interview question — Why not store hidden test inputs with the public result payload?** The database can reference test cases internally while the API returns only verdicts, preventing hidden expected values from leaking.

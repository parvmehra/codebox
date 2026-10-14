# Database design

PostgreSQL stores durable user, problem, test-case, submission, execution, and test-result data. Prisma defines the schema and checked-in migrations evolve it.

## Execution entities

- `Submission` stores the submitted source and current lifecycle status.
- `Execution` stores one worker attempt, its language version, Docker image, configured time and memory limits, start/completion timestamps, and aggregate runtime. `(submissionId, attemptNumber)` is unique so future retries can create distinct attempts.
- `ExecutionTestResult` stores a one-based test index, verdict, runtime, and optional error details. It does not store test input, expected output, or actual output.
- A result references its `TestCase` when available. Deleting a test case nulls the reference while preserving the historical verdict.

The submission API selects only verdict fields from the latest execution and never includes hidden test data.

## Learning notes

- **Problem solved:** execution metadata and per-test results remain available after the worker exits.
- **Why PostgreSQL:** the platform needs relational ownership, durable state transitions, foreign keys, and queryable submission history.
- **Important failure cases:** a worker can fail before writing its final status, a test case can later be deleted, or duplicate delivery can race. The schema preserves attempt history, and reliability work will add recovery metadata.
- **Interview question — Why keep source on `Submission`?** It is the immutable input the user submitted and is needed to review or rerun the original attempt.
- **Interview question — Why not store hidden test inputs with the public result payload?** The database can reference test cases internally while the API returns only verdicts, preventing hidden expected values from leaking.

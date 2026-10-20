# Reproducible executions

Phase 8 records which source, runtime profile, Docker image, and test-case revisions produced each result. Re-running a submission creates a new submission and execution linked to the original execution, so the first result remains available for comparison.

## Execution record

Each worker attempt stores:

- SHA-256 of the submitted UTF-8 source.
- The complete language profile, including commands, runtime version, and resource limits.
- The configured Docker image tag, the created container's immutable image ID, and the registry digest when Docker reports one.
- An ordered list of immutable test-case revisions.
- The existing per-test verdicts and aggregate runtime.

The submission detail endpoint returns execution history and this metadata to the submission's owner. It never returns test input or expected output.

## Test-case revisions

An admin creates a test case at version 1. Each update provides `expectedVersion`; the API atomically updates the current test case and appends the next immutable `TestCaseVersion`. If another admin has already changed it, the API returns `409 TEST_CASE_VERSION_CONFLICT` and preserves the newer revision.

The worker resolves the current revision when a submission first runs and pins that revision in `ExecutionTestCase`. Later edits affect new submissions only. An execution's saved test-case list also lets a re-run use the same inputs and expected outputs even after the current test cases change.

## Re-run behavior

`POST /api/submissions/:id/rerun` is available to the authenticated owner after an execution has completed. It creates a new `Submission` linked through `rerunOfExecutionId`, copies the submitted source and language, and queues it through the ordinary scheduler. The original submission and result rows are not modified.

The worker reads the source execution's profile and test-case revisions. It creates a new `Execution` under the new submission, capturing a fresh source hash and the image actually used. It prefers the saved registry digest as the image reference; if no digest was recorded, it uses the saved local image ID, with the old tag only as a legacy fallback.

## Limits and failure cases

- A registry digest makes an image addressable after a host change. If the image has no registry digest and its local Docker image ID has been pruned, the worker cannot recreate that exact image automatically.
- Executions created before this phase have no source hash or image identity. The migration associates their current test cases with version 1 as the best historical snapshot available; those executions cannot prove whether a test changed before this feature existed.
- A re-run is rejected with `409 SUBMISSION_NOT_RERUNNABLE` while the submission is active or when it has no completed execution.
- A failed queue publish leaves the new submission visible with a `SYSTEM_ERROR`; it does not affect the original result.

## Learning notes

- **Problem solved:** a result needs durable provenance so changes to language images or test cases do not erase what an earlier run used.
- **Why version rows:** an integer on the current test case alone cannot recover the previous input and expected output. Immutable revisions preserve both.
- **Why a new submission for a re-run:** it leaves the original status and results untouched and gives each user-requested run its own history and live lifecycle.
- **Why retain both image digest and image ID:** the digest can be pulled from a registry, while the ID identifies the exact local image used by Docker.
- **Interview question — Does the source hash let the worker reconstruct code?** No. The source remains on the submission; the hash checks its identity without duplicating the source in every execution.
- **Interview question — Why pin test versions per execution?** It prevents later admin edits from changing the inputs that a historical result claims to have evaluated.

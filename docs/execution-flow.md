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

1. Consume a RabbitMQ message containing a submission ID.
2. Claim the submission only while its status is `QUEUED`.
3. Resolve the language profile and load the problem's test cases.
4. Create an execution record with the profile's runtime version, image, and configured resource limits.
5. Create a fresh container and stream the source into its private `/workspace` tmpfs.
6. Run the profile's compile or syntax-check command. C++ writes its compiled binary to a separate executable tmpfs.
7. Run the program once per test case, passing each input through standard input.
8. Normalize line endings and whitespace before comparing output.
9. Persist each verdict, publish test progress, and publish the final submission state; remove the container, then acknowledge the message.

The API forwards queued, lifecycle, test-progress, and final events from a temporary RabbitMQ topic queue to the authenticated owner's Socket.IO room. The browser invalidates its REST query on each matching event and polls periodically as a reconnect fallback. The worker also publishes a heartbeat every 15 seconds; the status endpoint treats it as stale after 45 seconds.

The result API returns test number, verdict, runtime, compiler diagnostics, and a generic runtime error. Socket.IO events contain only status and per-test verdict metadata. Neither interface returns test input, expected output, or submitted-program stderr, including for hidden cases.

## Learning notes

- **Problem solved:** explicit states make progress and failure outcomes visible to both the UI and operators.
- **Why this design:** profiles isolate language-specific commands and limits, while the worker owns scheduling, persistence, and a shared evaluation path. Socket.IO gives the UI prompt updates, while REST stays the source for current state.
- **Important failure cases:** compile errors become `COMPILATION_ERROR`; program failures become runtime verdicts; Docker or database failures become `SYSTEM_ERROR` when that state can be persisted.
- **Interview question — Why compare normalized output?** It ignores harmless whitespace differences while preserving token order and values.
- **Interview question — Why persist per-test results?** A final verdict alone hides where evaluation stopped and cannot support a useful result page.

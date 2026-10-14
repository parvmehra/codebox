# Execution flow

The current execution path supports Java 21 only. The API rejects other languages until their profiles are implemented.

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
3. Load the Java language profile and the problem's test cases.
4. Create an execution record with the Java version, image, and configured resource limits.
5. Create a fresh container, copy in `Main.java`, and compile it with `javac`.
6. Run the compiled program once per test case, passing each input through standard input.
7. Normalize line endings and whitespace before comparing output.
8. Persist each verdict and the final submission state, remove the container and temporary source file, then acknowledge the message.

The result API returns test number, verdict, runtime, compiler diagnostics, and generic runtime errors. It does not return test input, expected output, or program stderr, including for hidden cases.

## Learning notes

- **Problem solved:** explicit states make progress and failure outcomes visible to both the UI and operators.
- **Why this design:** one Java profile isolates language-specific commands and limits, while the worker owns scheduling and persistence.
- **Important failure cases:** compile errors become `COMPILATION_ERROR`; program failures become runtime verdicts; Docker or database failures become `SYSTEM_ERROR` when that state can be persisted.
- **Interview question — Why compare normalized output?** It ignores harmless whitespace differences while preserving token order and values.
- **Interview question — Why persist per-test results?** A final verdict alone hides where evaluation stopped and cannot support a useful result page.

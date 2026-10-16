# Sandbox security

Submitted programs run in an ephemeral versioned runtime container: Java 21, Python 3.12, GCC 14 for C++23, or Node.js 22. The trusted worker is responsible for creating and removing it. This is educational isolation, not a guarantee against hostile-code attacks.

## Current controls

- No outbound network (`--network none`).
- Read-only container root filesystem with private temporary filesystems for `/workspace` and `/tmp`. Both mounts are `noexec`.
- Only C++ receives a separate, bounded executable tmpfs at `/exec` for the compiled binary.
- Non-root UID `65534:65534`, all Linux capabilities dropped, and `no-new-privileges` enabled.
- One CPU, swap disabled, and a 64-process limit. Java, Python, and Node.js use 256 MiB; C++ uses 512 MiB for compilation and execution.
- Compilation or syntax checks have a 15-second timeout, except C++ compilation at 30 seconds; each test run has a 2-second timeout.
- Source code is limited to 100,000 UTF-8 bytes and captured output to 1,000,000 bytes per command.
- The worker streams source through standard input into the private workspace tmpfs; it does not mount a host source directory.
- No host path is mounted into the execution container. The Docker socket exists only in the trusted worker container.
- Containers are removed in a `finally` block after success or failure, which also removes their temporary filesystems.

Memory usage is not yet measured, so `memoryUsedKb` remains null. The memory limit is enforced by Docker and an OOM-killed container maps to `MEMORY_LIMIT_EXCEEDED` when the daemon reports that condition.

## Limits and tradeoffs

Docker containers share the host kernel. A kernel or daemon vulnerability, unsafe host configuration, or compromised trusted worker could cross the intended boundary. Mounting the Docker socket gives the worker broad control over the daemon; it must never be exposed to submitted code. Stronger isolation, seccomp profiles, disk quotas, and adversarial testing are future hardening work.

## Learning notes

- **Problem solved:** separate short-lived containers keep a submitted program away from the API process and other submissions' workspaces.
- **Why these controls:** network, CPU, memory, process, time, source, and output bounds address common resource abuse without adding Kubernetes or cloud dependencies.
- **Important failure cases:** OOM kills, timeouts, output floods, Docker daemon errors, and cleanup failures all need explicit handling and honest reporting.
- **Interview question — Is Docker a complete security boundary?** No. This project demonstrates layered resource limits and isolation for learning; hostile-code services need stronger host and kernel security.
- **Interview question — Why does the worker need the Docker socket?** It orchestrates containers through the daemon. Submitted containers do not receive that socket or arbitrary mounts.

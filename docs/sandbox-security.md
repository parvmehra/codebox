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

## Threat model and trust boundaries (verified 2026)

**What is protected.** Submitted code runs with no network, a read-only root filesystem, no capabilities, `no-new-privileges`, uid 65534, memory = memory+swap, 1 CPU, a PID limit, tmpfs scratch space, and no host mounts. It cannot see application secrets or the Docker socket, and one test case cannot leave processes or files for the next (the executor kills the sandbox user's processes and clears `/tmp` between tests). These behaviors are checked for Python, Node.js, Java and C++ by `server/src/worker/docker-executor.integration.test.ts` (`CODEBOX_DOCKER_TESTS=1`), which was run on Docker Desktop (WSL2). Rerun it on the deployment host: seccomp, cgroup and rootfs behavior depend on the host kernel and Docker configuration.

**What is not protected.** Ordinary Docker isolation shares the host kernel. A kernel or runtime vulnerability reachable from inside a container is outside what this project defends against. Stronger isolation (gVisor, Kata or a microVM) is future work.

**The worker holds the Docker socket (F-01).** Submitted code never receives it, but the worker process does, so a vulnerability in the worker itself is equivalent to root on the Docker host. A socket proxy that filters by endpoint does not change this, because it does not inspect request bodies and a caller could still create a container with a host mount; it is deliberately not used. Mitigations that do work, in increasing strength: run workers on a dedicated host or VM that holds no other data and has no route to the database admin interface; use rootless Docker or Sysbox for the worker's daemon; use a microVM runtime. For a single-host deployment, run the worker host with only the credentials the worker needs.

**Resource measurement.** Memory usage is the container cgroup's `memory.peak`, read from outside the program, so a submission cannot misreport it. The cgroup is shared with the compiler and cannot be reset without root, so for compiled languages (Java, C++) the figure includes compilation. It is null on hosts without cgroup v2 `memory.peak`. Execution time is wall-clock around `docker exec`, so it includes process start-up (notably the JVM). Neither is a precise per-test CPU measurement.

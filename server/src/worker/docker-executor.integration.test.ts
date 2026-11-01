import { SubmissionStatus, TestResultStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { executeSubmission, type PersistedTestResult } from './docker-executor.js';
import {
  CPP_23_PROFILE,
  JAVA_21_PROFILE,
  NODE_22_PROFILE,
  PYTHON_3_12_PROFILE,
} from './language-profile.js';

// Runs real Docker containers. Opt in with CODEBOX_DOCKER_TESTS=1 (images must be pullable).
const describeDocker = process.env.CODEBOX_DOCKER_TESTS === '1' ? describe : describe.skip;

type Case = { input: string; expectedOut: string };

async function run(profile: typeof PYTHON_3_12_PROFILE, sourceCode: string, cases: Case[]) {
  const results: PersistedTestResult[] = [];
  const result = await executeSubmission(profile, {
    sourceCode,
    testCases: cases.map((testCase, index) => ({ id: `case-${index}`, ...testCase })),
    onPhase: async () => undefined,
    onTestResult: async (testResult) => {
      results.push(testResult);
    },
  });
  return { result, results };
}

const one: Case[] = [{ input: '', expectedOut: 'ok' }];

describeDocker('sandbox (real Docker)', () => {
  const py = PYTHON_3_12_PROFILE;

  it('accepts a correct program', async () => {
    const { result } = await run(py, 'print("ok")', one);
    expect(result.status).toBe(SubmissionStatus.ACCEPTED);
  });

  it('reports wrong answers and runtime errors separately', async () => {
    expect((await run(py, 'print("no")', one)).result.status).toBe(SubmissionStatus.WRONG_ANSWER);
    expect((await run(py, 'import sys; sys.exit(3)', one)).result.status).toBe(
      SubmissionStatus.RUNTIME_ERROR,
    );
    expect((await run(py, 'raise Exception("x")', one)).result.status).toBe(
      SubmissionStatus.RUNTIME_ERROR,
    );
  });

  it('reports a syntax error as a compilation error', async () => {
    expect((await run(py, 'def (', one)).result.status).toBe(SubmissionStatus.COMPILATION_ERROR);
  });

  it('stops an infinite loop with a time limit', async () => {
    const { result } = await run(py, 'while True: pass', one);
    expect(result.status).toBe(SubmissionStatus.TIME_LIMIT_EXCEEDED);
  }, 60_000);

  it('stops a memory bomb', async () => {
    const { result } = await run(py, 'x = bytearray(2 * 1024**3)\nprint("ok")', one);
    expect([SubmissionStatus.MEMORY_LIMIT_EXCEEDED, SubmissionStatus.RUNTIME_ERROR]).toContain(
      result.status,
    );
    expect(result.status).not.toBe(SubmissionStatus.ACCEPTED);
  }, 60_000);

  it('caps an output flood', async () => {
    const { result, results } = await run(py, 'while True: print("A" * 1000)', one);
    expect(result.status).toBe(SubmissionStatus.RUNTIME_ERROR);
    expect(results[0]?.errorMessage).toMatch(/output/i);
  }, 60_000);

  it('contains a fork bomb', async () => {
    const source = 'import os\nwhile True:\n  try: os.fork()\n  except OSError: pass';
    const { result } = await run(py, source, one);
    expect(result.status).not.toBe(SubmissionStatus.ACCEPTED);
    expect(result.status).not.toBe(SubmissionStatus.SYSTEM_ERROR);
  }, 90_000);

  it('has no network access', async () => {
    const source =
      'import socket\ntry:\n  socket.create_connection(("1.1.1.1", 80), timeout=2)\n  print("net")\nexcept OSError:\n  print("ok")';
    expect((await run(py, source, one)).result.status).toBe(SubmissionStatus.ACCEPTED);
  }, 30_000);

  it('cannot write to the read-only root filesystem', async () => {
    const source =
      'try:\n  open("/etc/pwned","w").write("x")\n  print("wrote")\nexcept OSError:\n  print("ok")';
    expect((await run(py, source, one)).result.status).toBe(SubmissionStatus.ACCEPTED);
  }, 30_000);

  it('does not expose host secrets, the Docker socket or app environment', async () => {
    const source = [
      'import os',
      'bad = os.path.exists("/var/run/docker.sock") or os.path.exists("/app") or "JWT_SECRET" in os.environ or "DATABASE_URL" in os.environ',
      'print("leak" if bad else "ok")',
    ].join('\n');
    expect((await run(py, source, one)).result.status).toBe(SubmissionStatus.ACCEPTED);
  }, 30_000);

  it('runs as an unprivileged user', async () => {
    const { result } = await run(
      py,
      'import os\nprint("ok" if os.getuid() == 65534 else "root")',
      one,
    );
    expect(result.status).toBe(SubmissionStatus.ACCEPTED);
  }, 30_000);

  it('removes the container afterwards', async () => {
    await run(py, 'print("ok")', one);
    const { execFileSync } = await import('node:child_process');
    const leftover = execFileSync('docker', ['ps', '-aq', '--filter', 'name=codebox-exec-'], {
      encoding: 'utf8',
    });
    expect(leftover.trim()).toBe('');
  }, 30_000);

  it('does not let one test case leave state for the next (F-05)', async () => {
    const source = [
      'import os, subprocess, sys',
      'mode = sys.stdin.read().strip()',
      'flag = "/tmp/flag"',
      'if mode == "write":',
      '  open(flag, "w").write("x")',
      '  subprocess.Popen(["sleep", "600"], start_new_session=True)',
      '  print("ok")',
      'else:',
      '  n = sum(1 for p in os.listdir("/proc") if p.isdigit() and "600" in open(f"/proc/{p}/cmdline").read())',
      '  print("leak" if os.path.exists(flag) or n else "ok")',
    ].join('\n');
    const { result } = await run(py, source, [
      { input: 'write', expectedOut: 'ok' },
      { input: 'read', expectedOut: 'ok' },
    ]);
    expect(result.status).toBe(SubmissionStatus.ACCEPTED);
  }, 60_000);

  it('runs Node.js programs', async () => {
    const { result } = await run(NODE_22_PROFILE, 'console.log("ok")', one);
    expect(result.status).toBe(SubmissionStatus.ACCEPTED);
    const tle = await run(NODE_22_PROFILE, 'while(true){}', one);
    expect(tle.result.status).toBe(SubmissionStatus.TIME_LIMIT_EXCEEDED);
    expect(TestResultStatus.TIME_LIMIT_EXCEEDED).toBe('TIME_LIMIT_EXCEEDED');
  }, 90_000);
});

type LanguageCase = {
  name: string;
  profile: typeof PYTHON_3_12_PROFILE;
  programs: {
    ok: string;
    wrong: string;
    compileError: string;
    exit3: string;
    loop: string;
    memory: string;
    flood: string;
    fork: string;
    network: string;
    writeRoot: string;
    uid: string;
    persistence: string;
  };
};

const javaMain = (body: string, imports = '') =>
  `${imports}\npublic class Main { public static void main(String[] a) throws Exception {\n${body}\n} }`;

const javaCase: LanguageCase = {
  name: 'Java',
  profile: JAVA_21_PROFILE,
  programs: {
    ok: javaMain('System.out.println("ok");'),
    wrong: javaMain('System.out.println("no");'),
    compileError: 'public class Main { void (',
    exit3: javaMain('System.exit(3);'),
    loop: javaMain('while (true) {}'),
    memory: javaMain(
      'java.util.List<long[]> l = new java.util.ArrayList<>(); while (true) l.add(new long[10_000_000]);',
    ),
    flood: javaMain('while (true) System.out.println("A".repeat(1000));'),
    fork: javaMain(
      'while (true) { try { new ProcessBuilder("sleep","600").start(); } catch (Exception e) { Thread.sleep(10); } }',
    ),
    network: javaMain(
      'try { new java.net.Socket().connect(new java.net.InetSocketAddress("1.1.1.1", 80), 2000); System.out.println("net"); } catch (Exception e) { System.out.println("ok"); }',
    ),
    writeRoot: javaMain(
      'try { new java.io.FileWriter("/etc/pwned").write("x"); System.out.println("wrote"); } catch (Exception e) { System.out.println("ok"); }',
    ),
    uid: javaMain(
      'String u = new String(new ProcessBuilder("id","-u").start().getInputStream().readAllBytes()).trim(); System.out.println(u.equals("65534") ? "ok" : "uid " + u);',
    ),
    persistence: javaMain(
      [
        'java.io.File f = new java.io.File("/tmp/flag");',
        'String mode = new java.util.Scanner(System.in).next();',
        'if (mode.equals("write")) { f.createNewFile(); new ProcessBuilder("sleep","600").start(); System.out.println("ok"); return; }',
        'boolean leak = f.exists();',
        'for (java.io.File p : new java.io.File("/proc").listFiles()) {',
        '  if (!Character.isDigit(p.getName().charAt(0))) continue;',
        '  try { String c = new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(p.getPath(), "cmdline"))); if (c.contains("600")) leak = true; } catch (Exception e) {}',
        '}',
        'System.out.println(leak ? "leak" : "ok");',
      ].join('\n'),
    ),
  },
};

const cppCase: LanguageCase = {
  name: 'C++',
  profile: CPP_23_PROFILE,
  programs: {
    ok: '#include <iostream>\nint main(){ std::cout << "ok"; }',
    wrong: '#include <iostream>\nint main(){ std::cout << "no"; }',
    compileError: 'int main( { ',
    exit3: 'int main(){ return 3; }',
    loop: 'int main(){ volatile int x = 0; while (true) { x = x + 1; } }',
    memory:
      '#include <cstdlib>\n#include <cstring>\nint main(){ while (true) { char* p = (char*)malloc(50000000); if (p) memset(p, 1, 50000000); } }',
    flood:
      '#include <cstdio>\nint main(){ while (true) puts("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"); }',
    fork: '#include <unistd.h>\nint main(){ while (true) fork(); }',
    network:
      '#include <sys/socket.h>\n#include <netinet/in.h>\n#include <arpa/inet.h>\n#include <cstdio>\nint main(){ int s = socket(AF_INET, SOCK_STREAM, 0); sockaddr_in a{}; a.sin_family = AF_INET; a.sin_port = htons(80); inet_pton(AF_INET, "1.1.1.1", &a.sin_addr); puts(connect(s, (sockaddr*)&a, sizeof a) == 0 ? "net" : "ok"); }',
    writeRoot:
      '#include <cstdio>\nint main(){ FILE* f = fopen("/etc/pwned", "w"); puts(f ? "wrote" : "ok"); }',
    uid: '#include <unistd.h>\n#include <cstdio>\nint main(){ puts(getuid() == 65534 ? "ok" : "root"); }',
    persistence: `#include <cstdio>
#include <cstring>
#include <unistd.h>
#include <dirent.h>
#include <string>
int main(){ char m[16] = {0}; scanf("%15s", m);
 if (!strcmp(m, "write")) { FILE* f = fopen("/tmp/flag", "w"); if (f) fclose(f); if (fork() == 0) { setsid(); execlp("sleep", "sleep", "600", (char*)0); _exit(0); } puts("ok"); return 0; }
 bool leak = access("/tmp/flag", F_OK) == 0; DIR* d = opendir("/proc"); dirent* e;
 while ((e = readdir(d))) { if (e->d_name[0] < '0' || e->d_name[0] > '9') continue; std::string p = std::string("/proc/") + e->d_name + "/cmdline"; FILE* c = fopen(p.c_str(), "r"); if (!c) continue; char b[256] = {0}; size_t n = fread(b, 1, 255, c); fclose(c); for (size_t i = 0; i + 2 < n; i++) if (b[i] == '6' && b[i+1] == '0' && b[i+2] == '0') leak = true; }
 puts(leak ? "leak" : "ok"); }`,
  },
};

for (const lang of [javaCase, cppCase]) {
  describeDocker(`sandbox (real Docker): ${lang.name}`, () => {
    const p = lang.programs;
    const status = async (source: string, cases: Case[] = one) =>
      (await run(lang.profile, source, cases)).result.status;

    it('accepts a correct program and rejects a wrong one', async () => {
      expect(await status(p.ok)).toBe(SubmissionStatus.ACCEPTED);
      expect(await status(p.wrong)).toBe(SubmissionStatus.WRONG_ANSWER);
    }, 120_000);

    it('reports compile errors and runtime errors separately', async () => {
      expect(await status(p.compileError)).toBe(SubmissionStatus.COMPILATION_ERROR);
      expect(await status(p.exit3)).toBe(SubmissionStatus.RUNTIME_ERROR);
    }, 120_000);

    it('stops an infinite loop with a time limit', async () => {
      expect(await status(p.loop)).toBe(SubmissionStatus.TIME_LIMIT_EXCEEDED);
    }, 120_000);

    it('stops a memory bomb', async () => {
      const result = await status(p.memory);
      expect([SubmissionStatus.MEMORY_LIMIT_EXCEEDED, SubmissionStatus.RUNTIME_ERROR]).toContain(
        result,
      );
    }, 120_000);

    it('caps an output flood', async () => {
      const { result, results } = await run(lang.profile, p.flood, one);
      expect(result.status).toBe(SubmissionStatus.RUNTIME_ERROR);
      expect(results[0]?.errorMessage).toMatch(/output/i);
    }, 120_000);

    it('contains a fork bomb', async () => {
      const result = await status(p.fork);
      expect(result).not.toBe(SubmissionStatus.ACCEPTED);
      expect(result).not.toBe(SubmissionStatus.SYSTEM_ERROR);
    }, 150_000);

    it('has no network, a read-only root filesystem, and no root user', async () => {
      expect(await status(p.network)).toBe(SubmissionStatus.ACCEPTED);
      expect(await status(p.writeRoot)).toBe(SubmissionStatus.ACCEPTED);
      expect(await status(p.uid)).toBe(SubmissionStatus.ACCEPTED);
    }, 150_000);

    it('does not let one test case leave state for the next', async () => {
      const result = await status(p.persistence, [
        { input: 'write', expectedOut: 'ok' },
        { input: 'read', expectedOut: 'ok' },
      ]);
      expect(result).toBe(SubmissionStatus.ACCEPTED);
    }, 150_000);
  });
}

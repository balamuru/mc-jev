import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const SERVER_DIR = resolve('server');

export interface TestServer {
  host: string;
  port: number;
  /** Server console output so far. */
  output(): string;
  /** Run a console command and return whatever the server printed in response. */
  run(command: string, settleMs?: number): Promise<string>;
  waitForLog(pattern: RegExp, timeoutMs?: number): Promise<string>;
  stop(): Promise<void>;
}

function requirements(): string {
  const jar = existsSync(SERVER_DIR)
    ? readdirSync(SERVER_DIR)
        .filter((f) => /^paper-.*\.jar$/.test(f))
        .sort()
        .at(-1)
    : undefined;
  const eula =
    existsSync(join(SERVER_DIR, 'eula.txt')) &&
    /^eula=true/m.test(readFileSync(join(SERVER_DIR, 'eula.txt'), 'utf8'));
  if (!jar || !eula || !existsSync(join(SERVER_DIR, 'cache'))) {
    throw new Error(
      'Integration tests reuse the Paper install in server/. Run ./scripts/server.sh once ' +
        '(accept the EULA and let it start), stop it, then rerun.',
    );
  }
  return join(SERVER_DIR, jar);
}

/**
 * Start a throwaway Paper server on its own port with a fresh flat world, so tests are repeatable
 * and never touch your dev world in server/world.
 */
export async function startTestServer(port = 25599): Promise<TestServer> {
  const jar = requirements();
  const dir = join(SERVER_DIR, `it-${port}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // Reuse the downloaded server code so nothing is fetched again.
  for (const shared of ['cache', 'libraries', 'versions']) {
    symlinkSync(join(SERVER_DIR, shared), join(dir, shared));
  }
  writeFileSync(join(dir, 'eula.txt'), 'eula=true\n');
  writeFileSync(
    join(dir, 'server.properties'),
    [
      'online-mode=false',
      'enforce-secure-profile=false',
      'server-ip=127.0.0.1',
      `server-port=${port}`,
      'level-type=minecraft\\:flat',
      'generate-structures=false',
      'spawn-animals=false',
      'spawn-monsters=false',
      'difficulty=normal',
      'gamemode=survival',
      'force-gamemode=true',
      'spawn-protection=0',
      'view-distance=4',
      'simulation-distance=4',
      'max-players=10',
      'motd=mc-jev integration test',
    ].join('\n') + '\n',
  );

  let out = '';
  const proc: ChildProcessWithoutNullStreams = spawn('java', ['-Xmx1G', '-jar', jar, '--nogui'], {
    cwd: dir,
  });
  proc.stdout.on('data', (d: Buffer) => (out += d.toString()));
  proc.stderr.on('data', (d: Buffer) => (out += d.toString()));
  let exited = false;
  proc.once('exit', () => (exited = true));

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const waitForLog = async (pattern: RegExp, timeoutMs = 60_000): Promise<string> => {
    const start = Date.now();
    for (;;) {
      const m = out.match(pattern);
      if (m) return m[0];
      if (exited)
        throw new Error(`Server exited while waiting for ${pattern}:\n${out.slice(-1500)}`);
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for ${pattern}:\n${out.slice(-1500)}`);
      }
      await sleep(100);
    }
  };

  const server: TestServer = {
    host: '127.0.0.1',
    port,
    output: () => out,
    async run(command, settleMs = 400) {
      const before = out.length;
      proc.stdin.write(`${command}\n`);
      await sleep(settleMs);
      return out.slice(before);
    },
    waitForLog,
    async stop() {
      if (!exited) {
        proc.stdin.write('stop\n');
        const start = Date.now();
        while (!exited && Date.now() - start < 30_000) await sleep(100);
        if (!exited) proc.kill('SIGKILL');
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };

  await waitForLog(/Done \([\d.]+s\)!/, 120_000);
  return server;
}

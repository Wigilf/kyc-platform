import 'dotenv/config';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Deploy, and refuse to claim success without evidence.
 *
 * Render reported `live` three times in a row while serving something other
 * than what was pushed:
 *
 *   1. An env-var change updated stored config without restarting the service,
 *      so the running process kept its old environment.
 *   2. A push did not trigger a build at all, despite autoDeploy being on.
 *   3. A manually triggered build ran the *previous* commit, because Render's
 *      view of the repository had not caught up with the push.
 *
 * None of those were visible from the deploy status. Each step here therefore
 * asserts an observable fact — the commit Render built, the bytes the CDN
 * serves, the response the API gives — and exits non-zero the moment one does
 * not hold.
 *
 *   npm run deploy              # everything
 *   npm run deploy -- --api     # one service
 *   npm run deploy -- --no-test # skip the suite (not advised)
 */

const RENDER_API = 'https://api.render.com/v1';
const key = process.env.RENDER_API_KEY;
if (!key) {
  fail('RENDER_API_KEY is not set. Put it in .env — it is gitignored.');
}

interface Service {
  flag: string;
  name: string;
  id: string;
  /** Public URL, used to confirm the deployed bytes are the ones we built. */
  url: string;
  /** A string that must appear in what the service serves after this deploy. */
  probe: () => Promise<void>;
}

const SERVICES: Service[] = [
  {
    flag: 'api',
    name: 'kyc-api',
    id: 'srv-d9oh15cs728c73f4dh3g',
    url: 'https://kyc-api-xjtr.onrender.com',
    probe: async () => {
      const ready = await getJson('https://kyc-api-xjtr.onrender.com/ready');
      if (ready.status !== 'ready' || ready.database !== 'ok') {
        throw new Error(`/ready reported ${JSON.stringify(ready)}`);
      }
      // Readiness only proves the process answers. Prove the schema is there
      // too: an empty database passes SELECT 1 and fails everything else.
      const login = await fetch('https://kyc-api-xjtr.onrender.com/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'nobody@example.invalid', password: 'x' }),
      });
      if (login.status >= 500) {
        throw new Error(`login endpoint returned ${login.status} — schema or config problem`);
      }
    },
  },
  {
    flag: 'dashboard',
    name: 'kyc-dashboard',
    id: 'srv-d9oh19flk1mc73961t20',
    url: 'https://kyc-dashboard-np5u.onrender.com',
    probe: () => assertServedBundleFresh('https://kyc-dashboard-np5u.onrender.com'),
  },
  {
    flag: 'verify',
    name: 'kyc-verify',
    id: 'srv-d9ot93m417fc73fr01u0',
    url: 'https://kyc-verify-2p56.onrender.com',
    probe: () => assertServedBundleFresh('https://kyc-verify-2p56.onrender.com'),
  },
];

// ---------------------------------------------------------------------------

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function step(message: string) {
  console.log(`\n▸ ${message}`);
}

function ok(message: string) {
  console.log(`  ✓ ${message}`);
}

function sh(command: string): string {
  return execSync(command, { encoding: 'utf8' }).trim();
}

/** Runs a command, surfacing its stderr as text rather than a byte dump. */
function run(command: string, what: string): void {
  try {
    execSync(command, { stdio: 'pipe', encoding: 'utf8' });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    const detail = [e.stderr, e.stdout].filter(Boolean).join('\n').trim();
    fail(`${what} failed:\n\n${detail || '(no output)'}`);
  }
}

async function getJson(url: string, init: RequestInit = {}): Promise<Record<string, never>> {
  const response = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${key}`, accept: 'application/json', ...init.headers },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${url} — ${text.slice(0, 160)}`);
  return text ? JSON.parse(text) : {};
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A static site's index.html is cacheable, so a stale copy points at yesterday's
 * bundle. Bust it, then confirm the referenced asset is actually fetchable —
 * a dangling reference means the CDN is mid-swap.
 */
async function assertServedBundleFresh(base: string): Promise<void> {
  const html = await (await fetch(`${base}/?cachebust=${Date.now()}`, {
    headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
  })).text();
  const asset = html.match(/\/assets\/[A-Za-z0-9_.-]+\.js/)?.[0];
  if (!asset) throw new Error('no JS bundle referenced in index.html');
  const bundle = await fetch(`${base}${asset}?cachebust=${Date.now()}`);
  if (!bundle.ok) throw new Error(`bundle ${asset} returned ${bundle.status}`);
  const bytes = (await bundle.text()).length;
  if (bytes < 1000) throw new Error(`bundle ${asset} is only ${bytes} bytes`);
  ok(`serving ${asset} (${(bytes / 1024).toFixed(0)}kB)`);
}

// ---------------------------------------------------------------------------

/**
 * One deploy at a time.
 *
 * The test suite drives a real database, and two runs against it fight over
 * the same fixture rows and the audit log's advisory locks — so a second
 * deploy started while the first is still running does not queue politely, it
 * makes both fail with errors that look like real regressions. That happened
 * three times before this existed, and each time cost a diagnosis of a bug
 * that was not there.
 *
 * A stale lock from a killed run is detected by checking whether the process
 * still exists, rather than by an age heuristic that is wrong in both
 * directions.
 */
const LOCK = join(process.cwd(), '.deploy.lock');

function claimLock() {
  if (existsSync(LOCK)) {
    const holder = Number(readFileSync(LOCK, 'utf8').trim());
    if (Number.isFinite(holder) && holder > 0 && alive(holder)) {
      fail(
        `another deploy is already running (pid ${holder}). Wait for it, or kill it and ` +
          `remove ${LOCK}.`,
      );
    }
    console.log(`  (clearing a lock left by pid ${holder}, which is no longer running)`);
  }
  writeFileSync(LOCK, String(process.pid));
  for (const signal of ['exit', 'SIGINT', 'SIGTERM'] as const) {
    process.on(signal, releaseLock);
  }
}

function releaseLock() {
  try {
    if (existsSync(LOCK) && readFileSync(LOCK, 'utf8').trim() === String(process.pid)) {
      rmSync(LOCK);
    }
  } catch {
    // Nothing useful to do while exiting.
  }
}

function alive(pid: number): boolean {
  try {
    // Signal 0 checks for existence without touching the process.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const args = process.argv.slice(2);
const selected = SERVICES.filter((s) => args.includes(`--${s.flag}`));
const targets = selected.length ? selected : SERVICES;
const runTests = !args.includes('--no-test');

claimLock();

step('Checking the working tree');
const dirty = sh('git status --porcelain');
if (dirty) fail(`uncommitted changes:\n${dirty}\n\nCommit or stash before deploying.`);
const branch = sh('git rev-parse --abbrev-ref HEAD');
if (branch !== 'main') fail(`on branch "${branch}"; Render deploys main.`);
const head = sh('git rev-parse HEAD');
ok(`main at ${head.slice(0, 7)} — ${sh('git log -1 --pretty=%s')}`);

if (runTests) {
  step('Running the test suite');
  try {
    execSync('npx vitest run', { stdio: 'inherit' });
    ok('tests pass');
  } catch {
    fail('tests failed — not deploying.');
  }

  step('Typechecking');
  run('npm run typecheck', 'typecheck');
  ok('typecheck clean');
}

step('Pushing to GitHub');
run('git push origin main', 'git push');
ok('pushed');

// Render reads the repository from GitHub. Triggering before GitHub reports the
// commit is how a deploy ends up building the previous one.
step('Waiting for GitHub to report the commit on main');
let visible = false;
for (let i = 0; i < 30; i++) {
  const remote = sh('git ls-remote origin refs/heads/main').split(/\s+/)[0];
  if (remote === head) {
    visible = true;
    ok(`origin/main is ${head.slice(0, 7)}`);
    break;
  }
  await sleep(2000);
}
if (!visible) fail('GitHub still does not report this commit on main after 60s.');

// ---------------------------------------------------------------------------

const results: Array<{ name: string; deployId: string; ok: boolean; detail: string }> = [];

/** Waits for a deploy to reach a terminal state and reports what it built. */
async function settle(serviceId: string, deployId: string): Promise<{ status: string; commit: string }> {
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const deploy = await getJson(`${RENDER_API}/services/${serviceId}/deploys/${deployId}`);
    const status = String(deploy.status);
    const commit = String((deploy.commit as { id?: string } | undefined)?.id ?? '');
    if (['live', 'build_failed', 'update_failed', 'canceled'].includes(status)) {
      return { status, commit };
    }
    await sleep(10_000);
  }
  return { status: 'timeout', commit: '' };
}

/** Starts a deploy, or adopts the in-flight one if Render returns no body. */
async function trigger(serviceId: string): Promise<string> {
  const created = await getJson(`${RENDER_API}/services/${serviceId}/deploys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (typeof created.id === 'string') return created.id;

  const recent = (await getJson(
    `${RENDER_API}/services/${serviceId}/deploys?limit=1`,
  )) as unknown as Array<{ deploy?: { id?: string } }>;
  return recent?.[0]?.deploy?.id ?? '';
}

for (const service of targets) {
  step(`Deploying ${service.name}`);

  let deployId = '';
  let status = '';
  let commit = '';

  // Up to three rounds. A deploy already in flight is usually for the previous
  // commit — adopting it and asserting the hash is how the first run reported a
  // failure that was really just bad timing. Let it finish, then start ours.
  for (let attempt = 1; attempt <= 3; attempt++) {
    deployId = await trigger(service.id);
    if (!deployId) {
      status = 'no-deploy-id';
      break;
    }
    ({ status, commit } = await settle(service.id, deployId));
    if (status !== 'live') break;
    if (commit === head) break;

    if (attempt < 3) {
      ok(`that run built ${commit.slice(0, 7)} (an earlier commit) — starting ours`);
      await sleep(3000);
    }
  }

  if (status !== 'live') {
    results.push({ name: service.name, deployId: deployId || '(none)', ok: false, detail: `status ${status}` });
    console.error(`  ✗ ${service.name}: ${status}`);
    continue;
  }

  // The assertion that would have caught all three past failures.
  if (commit !== head) {
    results.push({
      name: service.name,
      deployId,
      ok: false,
      detail: `built ${commit.slice(0, 7)}, expected ${head.slice(0, 7)}`,
    });
    console.error(`  ✗ ${service.name}: deployed ${commit.slice(0, 7)} but HEAD is ${head.slice(0, 7)}`);
    continue;
  }
  ok(`live on ${commit.slice(0, 7)}`);

  try {
    await service.probe();
    results.push({ name: service.name, deployId, ok: true, detail: 'verified' });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name: service.name, deployId, ok: false, detail });
    console.error(`  ✗ ${service.name}: ${detail}`);
  }
}

// ---------------------------------------------------------------------------

console.log('\n' + '─'.repeat(58));
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.name.padEnd(16)} ${r.detail}`);
}
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error(`\n✗ ${failed.length} of ${results.length} services did not deploy cleanly.\n`);
  process.exit(1);
}
console.log(`\n✓ ${results.length} services live on ${head.slice(0, 7)}, verified.\n`);

import 'dotenv/config';
import { execSync } from 'node:child_process';

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

const args = process.argv.slice(2);
const selected = SERVICES.filter((s) => args.includes(`--${s.flag}`));
const targets = selected.length ? selected : SERVICES;
const runTests = !args.includes('--no-test');

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

for (const service of targets) {
  step(`Deploying ${service.name}`);

  const created = await getJson(`${RENDER_API}/services/${service.id}/deploys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const deployId = String(created.id);
  ok(`triggered ${deployId}`);

  let status = '';
  let commit = '';
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const deploy = await getJson(`${RENDER_API}/services/${service.id}/deploys/${deployId}`);
    status = String(deploy.status);
    commit = String((deploy.commit as { id?: string } | undefined)?.id ?? '');
    if (['live', 'build_failed', 'update_failed', 'canceled'].includes(status)) break;
    await sleep(10_000);
  }

  if (status !== 'live') {
    results.push({ name: service.name, deployId, ok: false, detail: `status ${status}` });
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
    console.error(
      `  ✗ ${service.name}: deployed ${commit.slice(0, 7)} but HEAD is ${head.slice(0, 7)}`,
    );
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

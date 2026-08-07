/**
 * End-to-end tests against the shape production actually has.
 *
 * Two bugs shipped that no unit test could have caught and local development
 * actively hid:
 *
 *  - Every request for a document image was answered 414, because a storage
 *    key is longer than Fastify's default cap on path parameters. Nothing in
 *    the console called that route, so nothing noticed for months.
 *  - The console built image URLs from an environment variable that did not
 *    exist, so they resolved against the dashboard's own origin. That works
 *    perfectly in development, where the Vite dev server proxies `/v1` to the
 *    API and everything is same-origin, and 404s in every real deployment,
 *    where the console and the API are different hosts.
 *
 * Both were found by opening a browser against the deployed site. That is not
 * a repeatable check, so this is: it builds the production bundles, serves
 * them from a plain static server on a *different origin* from the API — no
 * proxy, real CORS, real cross-origin URL construction — and drives them with
 * a real browser.
 *
 * The assertion that matters most is not any single expectation below. It is
 * that a page must finish with no failed network request and no console error.
 * Both of the bugs above would have failed on that line alone.
 *
 *   npm run test:browser
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');

const API_PORT = 4400;
const DASHBOARD_PORT = 4410;
const VERIFY_PORT = 4411;
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
const DASHBOARD_ORIGIN = `http://localhost:${DASHBOARD_PORT}`;
const VERIFY_ORIGIN = `http://localhost:${VERIFY_PORT}`;

// Deliberately different hostnames as well as ports. `localhost` and
// `127.0.0.1` are distinct origins to a browser, so a request from the console
// to the API is genuinely cross-site and CORS has to be right for it to work —
// exactly as in a deployment, and not as in `npm run dev`.

const SEED_PASSWORD = process.env.SEED_PASSWORD ?? 'dev-only-local-password';
const REVIEWER = 'compliance@acme.test';

const children: ChildProcess[] = [];
const servers: Server[] = [];

interface Failure {
  test: string;
  detail: string;
}
const failures: Failure[] = [];
let passed = 0;
/** The page most recently under test, for a screenshot when something throws. */
let lastPage: Page | null = null;

async function main() {
  await build();
  await startApi();
  serveStatic(join(ROOT, 'apps/dashboard/dist'), DASHBOARD_PORT);
  serveStatic(join(ROOT, 'apps/verify/dist'), VERIFY_PORT);

  const browser = await chromium.launch({
    // A real applicant is asked for their camera. Granting a fake one keeps the
    // flow on the path most people take, rather than the file-upload fallback
    // that only appears when the camera is refused.
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  try {
    const applicantId = await applicantJourney(browser);
    await reviewerSeesTheDocument(browser, applicantId);
    await signedLinksAreNotOptional(browser);
  } finally {
    await browser.close();
  }

  report();
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

/** A whole verification, driven from the public page, cross-origin throughout. */
async function applicantJourney(browser: Browser): Promise<string> {
  const { page, done } = await watched(browser, 'applicant journey');

  // Taken from the wire rather than from storage: the page keeps the session
  // in memory, and a test that guesses where it lives fails quietly by falling
  // back to "whatever applicant happens to be newest".
  let applicantId = '';
  page.on('response', (response) => {
    if (response.url().endsWith('/v1/demo/sessions') && response.ok()) {
      void response
        .json()
        .then((body: { applicantId?: string }) => {
          applicantId = body.applicantId ?? '';
        })
        .catch(() => undefined);
    }
  });

  await page.goto(VERIFY_ORIGIN, { waitUntil: 'domcontentloaded' });
  await page.click('button.cta');
  await page.waitForSelector('.card ol.steps', { timeout: 60_000 });

  await page.click('.card ol.steps button.step-go');
  await page.waitForSelector('#kyc-firstName');
  for (const [field, value] of [
    ['firstName', 'Ada'],
    ['lastName', 'Specimen'],
    ['dob', '1990-05-12'],
    ['country', 'UTO'],
    ['email', 'ada@example.test'],
    ['addressLine1', '1 Test Street'],
    ['addressCity', 'Utopia City'],
    ['addressPostCode', '00001'],
  ] as const) {
    await page.fill(`#kyc-${field}`, value);
  }
  await page.click('.card form button[type=submit]');
  await page.waitForSelector('.card ol.steps li.done');

  const specimen = join(ROOT, 'apps/verify/public/specimen-passport.png');
  await driveToSubmit(page, specimen);

  await page.locator('.card button.primary', { hasText: /submit/i }).click();
  await page.waitForSelector('.verdict', { timeout: 300_000 });

  check('applicant journey', 'reached a verdict', Boolean(await page.locator('.verdict').count()));
  check('applicant journey', 'the applicant was identified', Boolean(applicantId));
  await done();
  return applicantId;
}

/** The case screen must show the document, not merely a row describing it. */
async function reviewerSeesTheDocument(browser: Browser, applicantId: string) {
  const { page, done } = await watched(browser, 'reviewer sees the document');

  await page.goto(`${DASHBOARD_ORIGIN}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('#email', REVIEWER);
  await page.fill('#password', SEED_PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForURL((url) => !url.pathname.includes('login'), { timeout: 60_000 });

  const target = applicantId || (await newestApplicantId());
  await page.goto(`${DASHBOARD_ORIGIN}/applicants/${target}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.doc-thumbs', { timeout: 60_000 });
  await page.waitForTimeout(2500);

  // Real pixels, not merely an <img> element that exists. A 414 or a 404 leaves
  // the element in place with naturalWidth 0, which is precisely how both of
  // the shipped bugs looked from the DOM.
  const thumbnails = await page.locator('.doc-thumb img').count();
  const loaded = await page
    .locator('.doc-thumb img')
    .evaluateAll((images) =>
      images.filter((i) => (i as HTMLImageElement).naturalWidth > 0).length,
    );

  check('reviewer sees the document', 'thumbnails present', thumbnails > 0, `${thumbnails} found`);
  check(
    'reviewer sees the document',
    'every thumbnail decoded to real pixels',
    thumbnails > 0 && loaded === thumbnails,
    `${loaded} of ${thumbnails} loaded`,
  );

  await page.locator('.doc-thumb').first().click();
  await page.waitForSelector('.lightbox');
  await page.waitForTimeout(1500);
  const full = await page
    .locator('.lightbox-stage img')
    .evaluate((i) => (i as HTMLImageElement).naturalWidth);
  check('reviewer sees the document', 'full-size image decoded', full > 0, `naturalWidth ${full}`);

  await done();
}

/** A document must not be reachable without a signature, whatever the driver. */
async function signedLinksAreNotOptional(browser: Browser) {
  const name = 'signed links are not optional';
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const key = await someStorageKey();
    const unsigned = await page.request.get(
      `${API_ORIGIN}/v1/files/${encodeURIComponent(key)}`,
    );
    check(name, 'unsigned request refused', unsigned.status() === 403, `got ${unsigned.status()}`);

    const forged = await page.request.get(
      `${API_ORIGIN}/v1/files/${encodeURIComponent(key)}?expires=${
        Math.floor(Date.now() / 1000) + 300
      }&signature=${'a'.repeat(64)}`,
    );
    check(name, 'forged signature refused', forged.status() === 403, `got ${forged.status()}`);
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * A page whose failures are the test.
 *
 * Every console error and every failed request is collected, and the page is
 * only considered to have passed if there were none. This is the assertion the
 * unit suite could not make and the one that catches whole categories at once:
 * a wrong URL, a blocked origin, a route that answers 414, an image that never
 * decodes.
 */
/** Saves what the browser was looking at when something went wrong. */
async function capture(page: Page, name: string) {
  const file = join(ROOT, `.e2e-${name.replace(/\W+/g, '-')}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => undefined);
  console.log(`   screenshot: ${file}`);
}

async function watched(browser: Browser, name: string) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const page = await context.newPage();
  const problems: string[] = [];

  page.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text().slice(0, 160)}`);
  });
  page.on('requestfailed', (request) =>
    problems.push(`request failed: ${request.method()} ${short(request.url())}`),
  );
  page.on('response', (response) => {
    // 4xx and 5xx on our own endpoints. Third-party noise is not our business,
    // and a deliberate 4xx in a negative test uses `page.request` instead.
    if (response.status() >= 400 && response.url().includes('/v1/')) {
      problems.push(`HTTP ${response.status()} ${short(response.url())}`);
    }
  });

  lastPage = page;
  return {
    page,
    async done() {
      check(name, 'no console errors or failed requests', problems.length === 0, unique(problems).join(' | '));
      await context.close();
    },
  };
}

function check(test: string, what: string, ok: boolean, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ✓ ${test} — ${what}`);
  } else {
    failures.push({ test, detail: `${what}${detail ? `: ${detail}` : ''}` });
    console.log(`  ✗ ${test} — ${what}${detail ? `: ${detail}` : ''}`);
  }
}

/**
 * Which screen the widget is on.
 *
 * Reading the state each time rather than assuming what a click produced. The
 * first version of this clicked and then immediately asked "am I on the
 * checklist?", which is a race: at that instant the click had not re-rendered
 * anything, so it answered yes and clicked again, and the flow desynchronised
 * a few steps later in a way that looked like a hang.
 */
async function screenOf(
  page: Page,
): Promise<'checklist' | 'capture' | 'review' | 'busy' | 'other'> {
  // Transient states first. The review screen's button becomes "Uploading…"
  // while the request is in flight, at which point it matches none of the
  // steady states and a naive reader concludes the flow is stuck.
  if (await page.locator('.card button[disabled], .card .spinner').count()) return 'busy';
  if (await page.locator('.card button', { hasText: /^use this photo$/i }).count()) return 'review';
  if (await page.locator('.card input[type=file]').count()) return 'capture';
  if (await page.locator('.card ol.steps').count()) return 'checklist';
  return 'other';
}

/** Feeds the specimen to every step until the checklist offers submission. */
async function driveToSubmit(page: Page, file: string) {
  for (let guard = 0; guard < 120; guard++) {
    const screen = await screenOf(page);

    if (screen === 'busy') {
      await page.waitForTimeout(500);
      continue;
    }

    if (screen === 'checklist') {
      const submit = page.locator('.card button.primary', { hasText: /submit/i });
      if (await submit.count()) return;
      const next = page.locator('.card button.primary').first();
      const before = (await next.textContent())?.trim();
      await next.click();
      // Wait for the click to have done something, rather than assuming.
      await page
        .waitForFunction(
          (label) => {
            const card = document.querySelector('.card');
            const primary = card?.querySelector('button.primary');
            return !card?.querySelector('ol.steps') || primary?.textContent?.trim() !== label;
          },
          before,
          { timeout: 30_000 },
        )
        .catch(() => undefined);
      continue;
    }

    if (screen === 'capture') {
      await page.locator('.card input[type=file]').setInputFiles(file);
      await page.locator('.card button', { hasText: /^use this photo$/i }).waitFor({ timeout: 30_000 });
      continue;
    }

    if (screen === 'review') {
      const use = page.locator('.card button', { hasText: /^use this photo$/i });
      await use.click();
      await use.waitFor({ state: 'detached', timeout: 60_000 });
      continue;
    }

    throw new Error(
      `Stuck: the card says "${(await page.textContent('.card'))?.replace(/\s+/g, ' ').trim().slice(0, 200)}"`,
    );
  }
  throw new Error('Gave up driving the flow to submission');
}

async function feedCaptureScreens(page: Page, file: string) {
  for (let guard = 0; guard < 8; guard++) {
    if (await page.locator('.card ol.steps').count()) return;
    const input = page.locator('.card input[type=file]');
    try {
      await input.waitFor({ state: 'attached', timeout: 30_000 });
    } catch {
      // Neither a checklist nor a capture screen. Say what is actually on the
      // page — a timeout that only reports a selector tells you nothing about
      // why the flow stopped.
      throw new Error(
        `Stuck: expected a capture screen or the checklist, and the card says ` +
          `"${(await page.textContent('.card'))?.replace(/\s+/g, ' ').trim().slice(0, 200)}"`,
      );
    }
    await input.setInputFiles(file);
    const use = page.locator('.card button', { hasText: /^use this photo$/i });
    await use.waitFor();
    await use.click();
    await use.waitFor({ state: 'detached' });
  }
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

async function build() {
  console.log('▸ Building the production bundles');
  // Pointed at the API's real origin, exactly as the deploy does. If this
  // variable is wrong, the console cannot reach the API — which is the bug this
  // whole file exists to catch, so it must not be papered over with a proxy.
  await run('npm', ['run', 'build:packages'], {});
  await run('npm', ['run', 'build:dashboard'], { VITE_API_BASE_URL: API_ORIGIN });
  await run('npm', ['run', 'build:verify'], {
    VITE_API_BASE_URL: API_ORIGIN,
    VITE_CONSOLE_URL: DASHBOARD_ORIGIN,
  });
}

async function startApi() {
  console.log('▸ Starting the API');
  const child = spawn('node', ['packages/api/dist/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(API_PORT),
      HOST: '127.0.0.1',
      RUN_WORKER_IN_PROCESS: 'true',
      DEMO_MODE: 'true',
      LOG_LEVEL: 'warn',
      // The static origins must be allowed explicitly. A missing entry here is
      // itself a production bug worth failing on.
      CORS_ORIGINS: `${DASHBOARD_ORIGIN},${VERIFY_ORIGIN}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stderr?.on('data', (d) => {
    const text = String(d);
    if (/error|fatal/i.test(text)) process.stderr.write(`  [api] ${text}`);
  });

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${API_ORIGIN}/health`);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await sleep(500);
  }
  throw new Error('The API did not become healthy in time');
}

/**
 * A plain static file server. No proxy, deliberately.
 *
 * The whole point is to serve the built assets the way a CDN does, so the
 * browser has to reach the API cross-origin.
 */
function serveStatic(root: string, port: number) {
  if (!existsSync(root)) throw new Error(`Nothing built at ${root}`);

  const server = createServer((request, response) => {
    const requested = decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/');
    const candidate = resolve(join(root, normalize(requested)));
    // A single-page app: unknown paths fall back to index.html, the same as
    // the rewrite rule the deploy configures.
    const file =
      candidate.startsWith(root) && existsSync(candidate) && statSync(candidate).isFile()
        ? candidate
        : join(root, 'index.html');

    response.writeHead(200, { 'content-type': contentType(file) });
    createReadStream(file).pipe(response);
  });
  server.listen(port, 'localhost');
  servers.push(server);
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};
const contentType = (file: string) => TYPES[extname(file)] ?? 'application/octet-stream';

function run(command: string, args: string[], env: Record<string, string>): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    child.on('exit', (code) =>
      code === 0 ? resolveRun() : rejectRun(new Error(`${command} ${args.join(' ')} failed:\n${stderr}`)),
    );
  });
}

// ---------------------------------------------------------------------------

async function newestApplicantId(): Promise<string> {
  const { prisma } = await import('@kyc/db');
  const applicant = await prisma.applicant.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
  return applicant.id;
}

async function someStorageKey(): Promise<string> {
  const { prisma } = await import('@kyc/db');
  const image = await prisma.documentImage.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
  return image.storageKey;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (url: string) => url.replace(API_ORIGIN, '').slice(0, 90);
const unique = (values: string[]) => [...new Set(values)];

function report() {
  console.log('');
  if (failures.length === 0) {
    console.log(`✓ ${passed} browser checks passed against production-shaped builds.`);
    return;
  }
  console.log(`✗ ${failures.length} failed, ${passed} passed:`);
  for (const failure of failures) console.log(`   ${failure.test} — ${failure.detail}`);
  process.exitCode = 1;
}

async function shutdown() {
  for (const child of children) child.kill('SIGTERM');
  for (const server of servers) server.close();
  const { prisma } = await import('@kyc/db');
  await prisma.$disconnect().catch(() => undefined);
}

try {
  await main();
} catch (error) {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  if (lastPage) await capture(lastPage, 'failure');
  process.exitCode = 1;
} finally {
  await shutdown();
}

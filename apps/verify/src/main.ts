import { KycVerification, type KycHandle } from '@kyc/websdk';

/**
 * Hosted verification.
 *
 * The applicant-facing counterpart to the reviewer console: open the link,
 * start a verification, work through whatever the level asks for, and see the
 * outcome — no account, no credentials.
 *
 * The widget owns the steps themselves. This page owns everything around them:
 * starting a session, and afterwards showing what the platform actually decided
 * and why. That last part matters — an applicant told only "we'll be in touch"
 * has seen half a KYC flow, and the half that is interesting to a person
 * evaluating the product is the reasoning.
 */

const API = normaliseBase(import.meta.env.VITE_API_BASE_URL);
const CONSOLE_URL = normaliseBase(import.meta.env.VITE_CONSOLE_URL) || '#';

function normaliseBase(raw: string | undefined): string {
  const value = (raw ?? '').trim().replace(/\/$/, '');
  if (!value) return '';
  // Render supplies a bare hostname; without a scheme this becomes a relative
  // URL and every call quietly hits this page instead of the API.
  return /^https?:\/\//.test(value) ? value : `https://${value}`;
}

const app = document.getElementById('app')!;

/**
 * Wakes the API as soon as the page loads.
 *
 * The page is static and served from a CDN, so it appears instantly; the API is
 * a separate service that sleeps when idle and takes up to a minute to wake.
 * Left until the button is clicked, that whole minute lands on the applicant
 * while they stare at a spinner. Starting it now overlaps the wake with the time
 * they spend reading, which is usually enough to hide it entirely.
 */
let apiWarm = false;
const warming = fetch(`${API}/health`, { cache: 'no-store' })
  .then(() => { apiWarm = true; })
  .catch(() => { /* the real request will report any genuine problem */ });

interface Session {
  token: string;
  applicantId: string;
  levelDisplayName: string;
  simulated: boolean;
}

let session: Session | null = null;
let widget: KycHandle | null = null;

// --- Small DOM helper -------------------------------------------------------

function h(tag: string, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
}

function shell(...children: Node[]) {
  app.replaceChildren(
    h(
      'div',
      { class: 'masthead' },
      h('div', { class: 'brand' }, 'Acme Fintech ', h('span', {}, '· identity verification')),
    ),
    h(
      'div',
      { class: 'notice' },
      h('strong', {}, 'Demonstration. '),
      'Do not upload a real ID. Passports and ID cards are really read — the ' +
        'machine-readable zone and its check digits — but nothing here judges ' +
        'whether a document is genuine, and selfies are not really examined. ' +
        'Sanctions screening against the published OFAC, EU and UN lists is real.',
    ),
    h('div', { class: 'panel' }, ...children),
    h(
      'div',
      { class: 'foot' },
      'Reviewers see submissions in the ',
      h('a', { href: CONSOLE_URL, target: '_blank', rel: 'noopener' }, 'operations console'),
      '.',
    ),
  );
}

// --- Screens ----------------------------------------------------------------

function renderIntro(error?: string) {
  const start = h('button', { class: 'cta' }, 'Start verification') as HTMLButtonElement;
  start.addEventListener('click', () => void beginSession(start));

  shell(
    h('h1', {}, 'Verify your identity'),
    h('p', { class: 'lead' }, 'Four short steps. It usually takes two or three minutes.'),
    h('p', { style: 'font-size:13.5px;margin:-8px 0 14px' }, "Here's what you'll be asked for — we'll walk you through them one at a time."),
    ...(error ? [h('div', { class: 'err' }, error)] : []),
    h(
      'ul',
      { class: 'what' },
      h('li', {}, h('span', { class: 'n' }, '1'), h('span', {}, 'Your details — name, date of birth, address')),
      h('li', {}, h('span', { class: 'n' }, '2'), h('span', {}, 'A photo of your passport or ID card')),
      h('li', {}, h('span', { class: 'n' }, '3'), h('span', {}, 'A selfie, to match against the document')),
      h('li', {}, h('span', { class: 'n' }, '4'), h('span', {}, 'A recent utility bill or bank statement')),
    ),
    start,
    h(
      'p',
      { style: 'font-size:13px;margin:14px 0 0;text-align:center' },
      'You can use your camera or upload files.',
    ),
    // Offered because the reader is real. Without a document that actually
    // reads, a visitor with nothing to hand uploads a screenshot, is told
    // truthfully that it could not be read, and concludes the thing is broken.
    h(
      'p',
      { style: 'font-size:13px;margin:8px 0 0;text-align:center' },
      'Nothing to hand? ',
      h(
        'a',
        { href: '/specimen-passport.png', download: 'specimen-passport.png' },
        'Download a specimen passport',
      ),
      ' — a fictional document with a valid machine-readable zone.',
    ),
  );
}

async function beginSession(button: HTMLButtonElement) {
  button.disabled = true;
  button.textContent = 'Starting…';

  // A silent wait reads as a broken button. Say what is happening, but only if
  // it actually takes long enough to worry about.
  const explain = setTimeout(() => {
    if (!apiWarm) {
      button.textContent = 'Waking the service…';
      const note = h(
        'p',
        { id: 'wake-note', style: 'font-size:13px;margin:12px 0 0;text-align:center' },
        'This demo sleeps when nobody is using it. First start can take up to a minute.',
      );
      button.parentElement?.append(note);
    }
  }, 3000);

  try {
    await warming.catch(() => undefined);
    const response = await fetch(`${API}/v1/demo/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.error?.message ?? `Could not start (${response.status})`);
    }
    clearTimeout(explain);
    session = payload as Session;
    renderFlow();
  } catch (error) {
    clearTimeout(explain);
    renderIntro(
      error instanceof Error
        ? `${error.message}. If the service was idle it may take up to a minute to wake — try again.`
        : 'Could not start a verification.',
    );
  }
}

function renderFlow() {
  if (!session) return;
  shell(h('div', { id: 'widget' }));

  widget?.destroy();
  widget = KycVerification.mount({
    container: '#widget',
    token: session.token,
    applicantId: session.applicantId,
    apiBaseUrl: API,
    // This page states it above the panel already.
    hideSimulationNotice: true,
    onComplete: () => {
      // The decision is made by a worker consuming a queue, so it is not ready
      // the instant submit returns.
      void pollOutcome();
    },
  });
}

async function pollOutcome() {
  if (!session) return;
  const waiting = (note: string) =>
    shell(
      h('h2', {}, 'Checking your details'),
      h('p', {}, 'Reading your document, then running the biometric and sanctions checks.'),
      h('div', { class: 'spinner' }, 'Working…'),
      h('p', { style: 'font-size:13px;text-align:center;margin:12px 0 0' }, note),
    );

  waiting('Usually under a minute.');

  // Five minutes, not sixty seconds.
  //
  // The old budget was thirty polls two seconds apart, from when the document
  // reader was simulated and returned instantly. Reading a real document on a
  // small shared instance takes tens of seconds per image, and a photo the
  // reader cannot make sense of takes the longest of all — so the page gave up
  // at sixty seconds on a verification that finished at seventy-one, and showed
  // "this is taking longer than expected" for a decision that had already been
  // made. Polling gently for five minutes costs nothing and covers it.
  const deadline = Date.now() + 5 * 60 * 1000;
  let elapsed = 0;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${API}/v1/demo/outcome/${session.applicantId}`, {
        headers: { authorization: `Bearer ${session.token}` },
      });
      if (response.ok) {
        const outcome = await response.json();
        if (outcome.reviewStatus !== 'PENDING' && outcome.reviewStatus !== 'NOT_STARTED') {
          renderOutcome(outcome);
          return;
        }
      }
    } catch {
      // Transient; keep polling until the deadline.
    }

    // Tight at first, because most answers arrive quickly; slower afterwards,
    // so a long wait is not also a hammering.
    const interval = elapsed < 30_000 ? 2000 : 5000;
    await new Promise((r) => setTimeout(r, interval));
    elapsed += interval;

    if (elapsed === 30_000) waiting('Still reading the document — this one is taking a while.');
    if (elapsed === 120_000) waiting('Still going. You can leave this page open.');
  }

  renderOutcome(null);
}

interface Outcome {
  reviewStatus: string;
  riskScore: number;
  riskLevel: string;
  automated: boolean;
  checks: Array<{
    type: string;
    status: string;
    result: string | null;
    provider: string | null;
    rejectLabels: string[];
  }>;
  screening: {
    searched: number;
    hits: Array<{ listName: string; matchedName: string; matchScore: number; matchedFields: string[] }>;
  };
}

const VERDICT: Record<string, { tone: string; title: string; body: string }> = {
  APPROVED: {
    tone: 'ok',
    title: 'Verified',
    body: 'Every check passed and the risk score was low enough to approve automatically. No one had to look at it.',
  },
  QUEUED: {
    tone: 'warn',
    title: 'Sent for review',
    body: 'Something needs a person to look at it — usually a screening match or an elevated risk score. A reviewer sees this in the operations console.',
  },
  REJECTED_RETRY: {
    tone: 'warn',
    title: 'We need you to try again',
    body: 'Something was wrong with what was submitted. In a real deployment you would be asked to resubmit.',
  },
  REJECTED_FINAL: {
    tone: 'fail',
    title: 'Could not be verified',
    body: 'A check failed in a way that cannot be resolved by resubmitting — a forged document, or a presentation attack.',
  },
  ON_HOLD: { tone: 'warn', title: 'On hold', body: 'Paused pending further information.' },
};

/** Acronyms stay upper-case: "Mrz validation" reads like a typo, not a check. */
const ACRONYMS = new Set(['ID', 'IP', 'MRZ', 'AML', 'OCR', 'PEP', 'NFC', 'UBO', 'KYB', 'SAR']);

function humanise(value: string): string {
  return value
    .split('_')
    .map((word, i) => {
      const upper = word.toUpperCase();
      if (ACRONYMS.has(upper)) return upper;
      const lower = word.toLowerCase();
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(' ');
}

function renderOutcome(outcome: Outcome | null) {
  if (!outcome) {
    shell(
      h('h2', {}, 'Still processing'),
      h(
        'p',
        {},
        'Your submission was received and the checks are still running — nothing has ' +
          'been lost. Reload this page in a minute to see the outcome.',
      ),
      startOver(),
    );
    return;
  }

  const verdict = VERDICT[outcome.reviewStatus] ?? {
    tone: 'info',
    title: humanise(outcome.reviewStatus),
    body: '',
  };

  const rows = outcome.checks
    .filter((c) => c.type !== 'MANUAL')
    .map((c) => {
      const result = c.result ?? c.status;
      const tone = result === 'PASS' ? 'ok' : result === 'FAIL' ? 'fail' : result === 'WARNING' ? 'warn' : 'info';
      return h(
        'tr',
        {},
        h(
          'td',
          {},
          humanise(c.type),
          ...(c.rejectLabels.length
            ? [h('div', { class: 'hit' }, h('span', { class: 'meta' }, c.rejectLabels.join(', ')))]
            : []),
        ),
        h('td', { class: 'v' }, h('span', { class: `pill ${tone}` }, result)),
      );
    });

  const hits = outcome.screening.hits.map((hit) =>
    h(
      'div',
      { class: 'hit' },
      h('div', { class: 'name' }, `${hit.matchedName} — ${hit.matchScore.toFixed(3)}`),
      h('div', { class: 'meta' }, `${hit.listName} · matched on ${hit.matchedFields.join(', ')}`),
    ),
  );

  shell(
    h(
      'div',
      { class: `verdict ${verdict.tone}` },
      h('span', {}, verdict.title),
    ),
    h('p', {}, verdict.body),
    h(
      'p',
      { style: 'font-size:14px' },
      `Risk score ${outcome.riskScore} of 100 (${outcome.riskLevel.toLowerCase()})`,
      outcome.automated ? ' · decided automatically by rules, with no human involved' : '',
    ),
    h('h2', { style: 'margin-top:22px' }, 'What was checked'),
    h('table', { class: 'checks' }, ...rows),
    ...(outcome.screening.searched > 0 || hits.length
      ? [
          h('h2', { style: 'margin-top:22px' }, 'Sanctions and PEP screening'),
          h(
            'p',
            { style: 'font-size:13.5px' },
            hits.length
              ? `Matched against the published watchlists. These are real entries from OFAC, the EU and the UN.`
              : 'Screened against the published OFAC, EU and UN lists — no matches.',
          ),
          ...hits,
        ]
      : []),
    startOver(),
  );
}

function startOver() {
  const again = h('button', { class: 'ghost', style: 'margin-top:22px' }, 'Run another verification');
  again.addEventListener('click', () => {
    widget?.destroy();
    widget = null;
    session = null;
    renderIntro();
  });
  return again;
}

renderIntro();

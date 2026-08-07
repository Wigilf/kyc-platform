# Working on this project

How I want work explained is in `~/.claude/CLAUDE.md` and applies everywhere.
This file is the project-specific part.

## What this project is

A KYC/AML platform — the software a regulated business uses to verify that a
customer is who they claim to be, and that they are not on a sanctions list.
Modelled on what Sumsub offers.

**KYC** is "know your customer"; **AML** is "anti-money-laundering"; a
**sanctions list** names people and companies that governments forbid doing
business with.

There are three things a user can touch:

| Surface | What it is | Who uses it |
|---|---|---|
| Hosted verification (`apps/verify`) | A public page: start a verification, upload documents, see the outcome | The customer being verified |
| Reviewer console (`apps/dashboard`) | Queues, case review, decisions, screening dispositions | Compliance staff |
| WebSDK (`packages/websdk`) | The same applicant flow, embeddable in someone else's website | A business integrating this |

## Where the code lives

| Package | Responsible for |
|---|---|
| `packages/core` | The domain rules, with no database or network in them: risk scoring, the applicant state machine, MRZ passport parsing, the rules engine, verification level definitions |
| `packages/db` | The database schema (Prisma), migrations, seed data, the audit log writer |
| `packages/adapters` | The boundary to outside providers — document reading, liveness, sanctions matching. Currently simulated; `ADAPTER_MODE=live` refuses to start rather than fake results |
| `packages/worker` | Background jobs: the verification pipeline, screening, webhook delivery, watchlist ingestion |
| `packages/api` | The HTTP API and all authentication |
| `packages/agent` | The AI support agent that answers applicant questions, with tool permissions per intent |

## Things that are load-bearing

- **Every write must be scoped to the caller's tenant.** Three case routes —
  assign, note, file a SAR — updated by id alone, so any agent could act on any
  tenant's case. `packages/api/test/tenant-isolation.test.ts` guards it. A
  handler that looks a record up by id and does not name a tenant is a bug.
- **Document access comes from a signature, never from being logged in.** The
  check must not depend on which storage driver is configured.
- **Only a session token authenticates.** The bearer path once treated any
  non-applicant token as a user token, which made the two-factor challenge —
  whose whole purpose is to be useless on its own — a working session.

Break these and something important stops being true, usually silently.

- **Only the latest check per document counts.** Reading an applicant's whole
  check history means a problem they already fixed keeps rejecting them
  forever. This bug shipped once; the tests in `packages/worker/test` guard it.
- **The audit log is a hash chain.** Each entry commits to the one before it, so
  editing or deleting one is detectable. That means entries can never be
  selectively deleted — only a whole tenant's chain, by deleting the tenant.
- **The AI agent cannot decide a verification.** No approve or reject tool
  exists in its registry. That absence is the guarantee; do not add one.
- **Automated decisions must be audited.** A rule rejecting someone is as
  consequential as a person doing it.
- **Simulated checks must say so.** Both UIs carry a banner whenever
  `ADAPTER_MODE` is not `live`. A generated pass must never read as evidence
  that someone's identity was verified.

## Running it

```bash
npm run bootstrap     # containers, migrations, seed data
npm run dev           # api + worker + reviewer console
npm run dev:verify    # the public verification page
npm test              # unit and integration; needs the local database
npm run test:browser  # a real browser against production-shaped builds
```

**Stop `npm run dev` before running the tests.** They share one database, and
a running worker consumes the queue jobs the pipeline tests are waiting on —
which shows up as two or three unrelated tests failing intermittently and sends
you hunting for a bug that is not there. It cost three diagnoses before I
noticed the dev worker was still up.

**`npm test` is not enough on its own.** Two bugs reached production that it
could not see, because the dev servers proxy `/v1` to the API and make
everything same-origin while a deployment puts the console, the page and the
API on three different hosts. `test:browser` builds the production bundles,
serves them from separate origins with no proxy, and drives them with a real
browser — it asserts that a page finishes with no failed request and no
console error, which is what catches a wrong origin, a blocked CORS rule or a
route that answers 414. Run it before deploying anything that touches a URL,
an origin, or a route shape.

Sign in to the console with `compliance@acme.test` and the password from
`SEED_PASSWORD` (locally it defaults to `dev-only-local-password`). The live
deployment's password is in `.render-secrets.local`, which is gitignored.

## Deployment

**The production database expires 2 September 2026** — free Render Postgres.
A verified backup is in `backups/` (gitignored). See LAUNCH.md.

Live on Render in the **KYC** project. `DEPLOY.md` has the detail, including the
free-tier limits worth knowing before sharing a link.

Sharp edges that have already caught me out:

- Render's `PUT /env-vars` updates stored config **without restarting the
  service** — the running process keeps its old environment until a deploy.
- `preDeployCommand` is a paid-plan feature. A free service accepts the field
  through the API and silently ignores it, so migrations run from the container
  entrypoint instead.
- Free services sleep after 15 minutes; the first request then takes ~50s.

## What is real and what is not

- **Real:** sanctions screening, against 26,440 live entries from OFAC, the EU
  and the UN. Refresh with `npm run watchlist:refresh`.
- **Real:** reading a passport or ID card. Tesseract transcribes the
  machine-readable zone and the ICAO 9303 check digits are verified, so a
  document that does not add up is caught. `ADAPTER_OCR=tesseract` turns it on;
  `mock` is the default. It reads only the MRZ — the printed fields are not
  transcribed, because nothing would detect a misread.
- **Simulated:** liveness and face matching. These need a paid vendor.
- **Real, when configured:** chip verification for an ePassport. The chip is
  signed by the issuing state; verifying that signature is *proof* the document
  is genuine, not an opinion about it. Needs `CSCA_DIR` pointing at trusted
  country certificates, and a mobile app to do the reading — a browser cannot
  talk to a chip. Without `CSCA_DIR` the simulated reader stays in place.
- **Absent:** authenticating a document from a *photograph*. Deciding whether a
  printed passport is a forgery needs a licensed library of what every document
  version from every country looks like. Reading a document is not
  authenticating one, and a competent forgery carries a perfectly valid MRZ —
  computing check digits is arithmetic. The chip is the way round this.
- **Absent:** PEP screening (politically exposed persons). No free authoritative
  source exists; the commercial registers are the product.

Do not describe this as able to verify a real person's identity. It cannot yet.

### Where documents live

Postgres, encrypted, by default — `STORAGE_DRIVER=postgres`. Against the
storage adapter's own advice, which is right at scale and was losing to a disk
the host wipes on every restart. Three things keep it honest rather than
merely expedient:

- **The exit is tested.** `packages/adapters/test/s3-storage.test.ts` runs the
  S3 driver against a real object store, including presigned URLs fetched
  directly from it. CI has MinIO for this.
- **The exit is safe to take.** `npm run storage:migrate -- --to s3` copies
  every object, verifies each against the digest recorded when it was written,
  reads back what it wrote, and refuses to continue on a mismatch. Deleting the
  originals is a separate invocation, after the switch is proved in production.
- **The threshold announces itself.** `/ready` reports how much the database is
  carrying and warns past 2GB, so "revisit before a few GB" is something the
  system says rather than a comment nobody reads.

### Chip verification

`packages/core/src/passive-auth.ts`, exposed as `POST /v1/applicants/:id/nfc`.

- **It proves the data, not the medium.** A bit-for-bit clone of a real chip
  passes passive authentication. Detecting that needs active or chip
  authentication, which is a conversation with the chip and therefore belongs
  in the mobile app. `activeAuthPassed` is `null`, never `false` — reporting an
  unanswered question as answered is how a clone gets in.
- **Trust anchors are compliance's, not the code's.** CSCA certificates come
  from the ICAO PKD or a national master list, they rotate, and which states to
  trust is a decision someone owns. No trust store means no verification, and
  the code says so loudly rather than passing.
- **Tests build their own passport PKI** (`packages/core/test/passport-pki.ts`),
  because only an issuing state can produce a real one — which is the whole
  point. That shared helper is imported by suites in two packages.

### The document reader

`packages/adapters/src/live/ocr-tesseract.ts`. Things worth knowing before
changing it:

- **It costs about 220MB resident and is slow on a small instance.** Measured:
  a document that reads in 0.17s on a laptop takes 18s on the free Render
  service — the CPU is throttled hard under sustained load. Budgets are
  therefore configurable (`OCR_TIMEOUT_MS`, 150s in production) and each pass
  gets a *share* of the budget rather than a fixed number of seconds. Memory
  peaked at 331MB of 512MB.
- **The crop at the foot of the page is the fast path.** Recognition cost scales
  with pixel count and the zone sits in the bottom third, so that strip is read
  first at 1400px wide. The full-page pass only runs if that fails, and on a
  slow instance it usually times out — which is fine, because it is the
  fallback, not the route.
- **Repairs are gated on the check digits.** OCR misreads the zone constantly,
  so candidate corrections are generated and only ones that make the arithmetic
  work are accepted — and even then the read is marked repaired and its
  confidence discounted. Never accept a repair that has not validated.
- **Absent and wrong check digits are different findings.** `MRZ_INCOMPLETE`
  means the photo lost them; `MRZ_CHECK_DIGIT_FAILED` means they are there and
  do not add up. Collapsing the two either cries fraud at blurred corners or
  waves through a doctored zone.
- **Nothing read must never mean nothing wrong.** Every other document check is
  a comparison, and an empty read fails none of them. The pipeline's
  `DOCUMENT_UNREADABLE` label exists for that; `packages/worker/test/pipeline-real-ocr.test.ts`
  guards it.

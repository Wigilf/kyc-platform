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
npm run bootstrap   # containers, migrations, seed data
npm run dev         # api + worker + reviewer console
npm run dev:verify  # the public verification page
npm test            # 65 tests; needs the local database running
```

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
- **Simulated:** document reading, liveness, face matching. These need a paid
  vendor.
- **Absent:** PEP screening (politically exposed persons). No free authoritative
  source exists; the commercial registers are the product.

Do not describe this as able to verify a real person's identity. It cannot yet.

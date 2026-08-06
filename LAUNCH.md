# Launch readiness

An honest assessment of what must be true before real people upload real
identity documents to this system. Written 4 August 2026.

> ## ⚠ The database expires on **2 September 2026**
>
> Free Render Postgres. On that date the data is deleted and does not come
> back. A verified backup exists in `backups/` (restored and row-checked on
> 4 August), so nothing is lost if the date is missed — but the live service
> stops working until a new database is provisioned.
>
> Either upgrade to a paid plan (about $6/month) or diary the restore.

**Summary: this cannot be launched today, and the reason is not polish.** The
identity verification is simulated. Everything around it — the pipeline, the
rules, the audit trail, the review workflow, the sanctions screening — is real
and working. The bit that looks at a passport and decides whether it is genuine
is not.

Items are grouped by what kind of problem they are, because they need different
kinds of solution: some are code, some are money, and some are decisions or
professional advice that nobody but the operator can supply.

---

## 1. Blockers — the product does not work without these

### 1.1 Identity verification is simulated

`ADAPTER_MODE=mock`. There is no document reading, no liveness detection, no
face matching. The mock adapters generate plausible results from the applicant's
own id. A "verified" result today means nothing about the person.

The code is ready for this: `packages/adapters` defines the boundary, and
`ADAPTER_MODE=live` deliberately throws rather than falling back to mocks. What
is missing is a provider behind it.

**What it needs:** an account with a verification vendor — Sumsub, Onfido,
Veriff, iDenfy and others all sell this — and an implementation of the adapter
interfaces against their API. Expect roughly €0.50–2.00 per verification, often
with a monthly minimum.

**This is a decision, not a task.** Which vendor, at what price, under what
contract, is the operator's call. Implementation is perhaps a week per provider
once credentials exist.

### 1.2 Uploaded documents are thrown away

`STORAGE_DRIVER=local` writes to the container's `/tmp`, which Render wipes on
every deploy and restart. An applicant's passport photograph survives until the
next deploy.

**What it needs:** `STORAGE_DRIVER=s3` against any S3-compatible bucket —
Cloudflare R2, Backblaze B2, AWS S3 — with server-side encryption, versioning
off, and a lifecycle rule matching the retention decision in §3.2. The adapter
already exists; this is configuration plus a bucket.

### 1.2b Reviewers cannot see the documents they are reviewing

Found on 6 August 2026, while answering "is the product done".

There is no endpoint that serves a document image, and no `<img>` anywhere in
the reviewer console — it lists documents by type and status only. So the
queue, the case view and the decision buttons all work, and the one thing a
human reviewer is there to do, look at the passport, is not possible.

This matters more than it sounds. Manual review is the fallback for everything
the automation declines to decide, which after the changes of 5-6 August is
most non-trivial cases. A review queue nobody can actually review is a queue
that will be cleared on vibes.

**What it needs:** an authenticated endpoint returning a short-lived signed URL
per image — the storage adapter already has `presignGet` — plus an image viewer
in the case screen with zoom, rotate, and side-by-side against the extracted
fields. Every access must be audited: looking at someone's passport is itself
a processing activity. Depends on §1.2, since there is no point serving bytes
that have been wiped.

### 1.3 The database expires on 2 September 2026

Free Render Postgres. On expiry the data is gone. There are also no backups, no
replica, and no point-in-time recovery.

**What it needs:** a paid plan (from about $6/month) and a verified restore.
A backup nobody has restored is not a backup.

### 1.4 The public demo endpoint is open

`DEMO_MODE=true` exposes `POST /v1/demo/sessions` with no authentication, so
anyone can create applicant records. Appropriate for a demonstration; not for
anything real.

**What it needs:** `DEMO_MODE=false`, and the hosted demo page taken down or
pointed at a separate sandbox tenant.

### 1.5 Published credentials

The seeded operator accounts exist on the live deployment. The password used to
be hardcoded in the seed and therefore published here; it has been rotated and
the seed now requires `SEED_PASSWORD`, refusing to run in production without it.

**What it needs:** the seed must not run against production; the demo accounts
removed; real accounts created with real passwords. Better still, put SSO in
front — the login endpoint is documented in the code as dev-grade.

---

## 2. Legal and regulatory — get advice, do not take mine

I can describe what the software does. I cannot tell you what you are permitted
to do with it, and nothing below is legal advice.

### 2.1 You would be processing biometric and identity data

Under GDPR, facial images used for identification are biometric data and fall
under Article 9 — a special category with a higher bar than ordinary personal
data. At minimum you need a lawful basis, a privacy notice, a record of
processing, and a data protection impact assessment.

### 2.2 Every processor needs a contract

The verification vendor from §1.1, the hosting provider, and any storage
provider are all processors acting on your behalf. Each needs a data processing
agreement. Where they sit matters: Render's Frankfurt region keeps data in the
EU, but a vendor's own processing may not.

### 2.3 Retention is contradictory and nothing implements it

AML rules typically require records be kept for five years after a relationship
ends. GDPR requires personal data not be kept longer than necessary. Both apply
at once, which means an explicit retention schedule and something that enforces
it.

**Nothing in this codebase deletes anything, ever.** No retention policy, no
purge job, no subject-access or erasure handling. The audit log is deliberately
append-only and hash-chained, which makes erasure genuinely awkward — that
tension needs a decided answer before real data arrives.

### 2.4 Operating a KYC service may itself be regulated

Depending on jurisdiction and whether you verify for yourself or for others,
this may require registration with a financial supervisor. Worth asking before
launch rather than after.

---

## 3. Operational — needed to run it responsibly

| Gap | Why it matters | Rough effort |
|---|---|---|
| No backups or tested restore | §1.3 | Half a day |
| No monitoring or alerting | A failed queue is currently invisible until someone notices | 1–2 days |
| No error tracking | Exceptions go to logs nobody reads | Half a day |
| Single instance, sleeps when idle | Free tier; ~50s cold start | $7/month |
| Workers share the API process | `RUN_WORKER_IN_PROCESS=true`; a slow job competes with requests | $7/month |
| Sanctions refresh is manual | `npm run watchlist:refresh` by hand. A stale watchlist is a compliance failure that looks like normal operation | 1 day to schedule |
| No PEP screening | No free source exists; commercial registers are the product | Vendor cost |
| Secrets never rotated | `PII_ENCRYPTION_KEY` has no rotation path, and rotating it makes existing data unreadable | 2–3 days for envelope re-encryption |
| No rate limiting beyond per-credential | Nothing in front of the API | 1 day |

---

## 4. What is genuinely production-quality already

Worth stating, because the list above is long and the foundation is not the
problem:

- **Sanctions screening is real** — 26,440 live entries from OFAC, the EU and
  the UN, refreshable, with dispositions that expire when a listing changes.
- **The audit trail is tamper-evident** — hash-chained, verified under
  concurrent writes, and it detects edits and deletions.
- **Decisions are attributable and explainable** — every automated decision
  records the rules that produced it.
- **The permission model holds** — applicant tokens cannot reach another
  applicant's record; the AI agent has no tool that can decide a verification.
- **The domain logic is tested** — 65 tests, including regressions for every
  bug that has shipped.
- **Deploys verify themselves** — `npm run deploy` refuses to report success
  without matching the deployed commit and probing the running result.

---

## 5. Suggested order

1. Decide the verification vendor (§1.1) — everything else is theatre until
   something really reads a document
2. Talk to a data protection adviser (§2) — this may change the architecture,
   and it is cheaper to hear that now
3. Paid database with tested restore, and S3 storage (§1.2, §1.3)
4. Turn off demo mode, remove seeded accounts, put SSO in front (§1.4, §1.5)
5. Retention schedule, and something that enforces it (§2.3)
6. Monitoring, alerting, scheduled watchlist refresh (§3)
7. Then a closed pilot with real documents and consenting testers, before
   anything public

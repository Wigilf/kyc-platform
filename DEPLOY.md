# Deploying to Render

Four resources, all on the free tier: the API (which also runs the queue
workers), Postgres, a Key Value store, and the dashboard as a static site.

## Before you start

Read this bit — it changes what you should expect from the URL you share.

- **Free web services sleep after 15 minutes idle** and take roughly 50 seconds
  to wake. The first request after a quiet period looks like a hang. If people
  are testing on and off, warn them, or move the API to the $7/mo Starter plan.
- **Free Postgres expires after 30 days** and the data goes with it.
- **The document and liveness checks are simulated.** `ADAPTER_MODE=mock` means
  no real OCR, no real face match, no real liveness. The UI says so on every
  screen. Nothing here can verify a real person's identity, and it must not be
  presented as though it can.

## Steps

### 1. Push the repository to GitHub

Render deploys from a Git repository.

```bash
gh repo create kyc-platform --private --source=. --remote=origin --push
```

### 2. Create the blueprint

In the Render dashboard: **New → Blueprint**, pick the repository, and Render
reads `render.yaml`. It will show four resources to create.

### 3. Supply the one secret Render cannot generate

`APP_SECRET` and `WEBHOOK_SIGNING_SECRET` are generated for you.
`PII_ENCRYPTION_KEY` cannot be, because it has to be exactly 64 hex characters
and Render's generator emits base64. Produce one:

```bash
openssl rand -hex 32
```

Paste it into the `PII_ENCRYPTION_KEY` field when Render prompts, or set it
afterwards under the service's Environment tab.

Keep a copy somewhere safe. **Changing this key makes every stored address
permanently unreadable** — it is the encryption key, not a password.

### 4. Seed the demo data

Migrations run automatically before each deploy. The demo tenant, operator
accounts and sample applicants do not — seeding is deliberately manual so a
redeploy can never overwrite real data.

Once the API is live, open its **Shell** tab in Render and run:

```bash
node --experimental-strip-types packages/db/prisma/seed.ts
```

### 5. Check it

```bash
curl https://kyc-api-XXXX.onrender.com/health
curl https://kyc-api-XXXX.onrender.com/ready     # also checks the database
```

Then open the dashboard URL and sign in with `compliance@acme.test` /
`demo1234`.

**Change that password before sharing the URL.** The seeded accounts are
public knowledge — they are in this repository.

## Environment variables

| Variable | Set by | Notes |
|---|---|---|
| `DATABASE_URL` | Render | From the Postgres instance |
| `REDIS_URL` | Render | From the Key Value instance |
| `APP_SECRET` | Render | Signs session and applicant tokens |
| `WEBHOOK_SIGNING_SECRET` | Render | Signs outbound webhooks |
| `PII_ENCRYPTION_KEY` | **You** | 64 hex chars; encrypts stored addresses |
| `RUN_WORKER_IN_PROCESS` | blueprint | `true` — no separate worker on free tier |
| `ADAPTER_MODE` | blueprint | `mock`; `live` refuses to start without real providers |
| `CORS_ORIGINS` | blueprint | The dashboard's origin |

The API refuses to start in production if `APP_SECRET`, `WEBHOOK_SIGNING_SECRET`
or `PII_ENCRYPTION_KEY` still hold their development placeholders.

## Running the applicant widget

The WebSDK is a library, not a hosted page. Embed it in your own page:

```html
<div id="kyc"></div>
<script type="module">
  import { KycVerification } from 'https://your-cdn/kyc-websdk.js';
  // Your backend mints this — never ship an API key to a browser.
  const { token, applicantId } = await fetch('/your-backend/kyc-token').then(r => r.json());
  KycVerification.mount({
    container: '#kyc',
    token,
    applicantId,
    apiBaseUrl: 'https://kyc-api-XXXX.onrender.com',
  });
</script>
```

Camera capture needs a secure context. Over HTTPS it works; over plain HTTP it
silently falls back to file upload.

## Sanctions data

The seeded watchlist is nine rows, enough to demonstrate matching. Real
screening needs the published lists:

```bash
DATABASE_URL="<your Render external connection string>" npm run watchlist:refresh
```

That pulls OFAC SDN, the UN consolidated list and the EU consolidated list —
roughly 55MB of XML and tens of thousands of entries. Run it from a workstation
rather than the free-tier container, which does not have the memory to parse
them.

Re-run it weekly or so. Entries that disappear from a source are marked inactive
rather than deleted, so historical hits stay explainable.

**PEP screening is not included.** There is no free authoritative source; the
commercial registers are the product. The seeded PEP rows are illustrative only.

## Storage

`STORAGE_DRIVER=local` writes uploads to the container's `/tmp`, which Render
wipes on every deploy and every restart. Fine for testing, wrong for anything
else. For persistence set `STORAGE_DRIVER=s3` and the `S3_*` variables against
any S3-compatible bucket (Cloudflare R2, Backblaze B2, AWS).

## Cost to remove the rough edges

| Change | Plan | Cost |
|---|---|---|
| API stops sleeping | Starter | $7/mo |
| Database stops expiring | Basic | $6/mo |
| Workers run separately from the API | +Worker | $7/mo |

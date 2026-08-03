import {
  ALL_DEFAULT_RULES,
  LEVEL_TEMPLATES,
  generateApiKey,
  nameTokens,
  newSecret,
  sha256,
} from '../../core/src/index.js';
import { PrismaClient } from '../generated/client/index.js';

/**
 * Seed data.
 *
 * Gives a fresh database enough to be genuinely exercised, not just to boot:
 * levels, the default rulesets, review queues, operator accounts, a watchlist
 * corpus with entries designed to produce both true and false positives, help
 * articles for the support agent, and a set of applicants that hit the
 * interesting paths (clean approve, blurry retry, forged reject, sanctions hit).
 */

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding…');

  // --- Tenant ---
  const tenant = await prisma.tenant.upsert({
    where: { slug: 'acme-fintech' },
    create: {
      name: 'Acme Fintech',
      slug: 'acme-fintech',
      homeCountry: 'GBR',
      industry: 'FINTECH',
      dataResidency: 'eu',
    },
    update: {},
  });

  // --- Operators, one per role so the RBAC boundaries can actually be tested ---
  const password = 'demo1234';
  const users = [
    { email: 'owner@acme.test', name: 'Dana Owner', role: 'OWNER' as const },
    { email: 'admin@acme.test', name: 'Alex Admin', role: 'ADMIN' as const },
    { email: 'compliance@acme.test', name: 'Priya Compliance', role: 'COMPLIANCE_OFFICER' as const },
    { email: 'mlro@acme.test', name: 'Marco MLRO', role: 'MLRO' as const },
    { email: 'agent@acme.test', name: 'Sam Agent', role: 'AGENT' as const },
    { email: 'auditor@acme.test', name: 'Ada Auditor', role: 'AUDITOR' as const },
    { email: 'ai-agent@acme.test', name: 'Support Assistant', role: 'AI_AGENT' as const },
  ];

  for (const user of users) {
    await prisma.user.upsert({
      where: { tenantId_email: { tenantId: tenant.id, email: user.email } },
      create: {
        tenantId: tenant.id,
        email: user.email,
        name: user.name,
        role: user.role,
        passwordHash: sha256(password),
      },
      update: { role: user.role, passwordHash: sha256(password) },
    });
  }

  // --- API key ---
  const existingKey = await prisma.apiKey.findFirst({
    where: { tenantId: tenant.id, name: 'seed-sandbox-key' },
  });
  let apiCredentials: { keyId: string; secret: string } | null = null;
  if (!existingKey) {
    const generated = generateApiKey();
    await prisma.apiKey.create({
      data: {
        tenantId: tenant.id,
        name: 'seed-sandbox-key',
        keyId: generated.keyId,
        secretHash: generated.secretHash,
        environment: 'SANDBOX',
      },
    });
    apiCredentials = { keyId: generated.keyId, secret: generated.secret };
  }

  // --- Levels from the built-in templates ---
  for (const template of Object.values(LEVEL_TEMPLATES)) {
    const existing = await prisma.verificationLevel.findFirst({
      where: { tenantId: tenant.id, name: template.name },
    });
    if (existing) continue;
    await prisma.verificationLevel.create({
      data: {
        tenantId: tenant.id,
        name: template.name,
        displayName: template.displayName,
        description: template.description,
        subjectType: template.subjectType,
        version: 1,
        steps: template.steps as never,
        allowedCountries: template.allowedCountries,
        blockedCountries: template.blockedCountries,
        autoApprove: template.autoApprove,
        autoReject: template.autoReject,
        manualReviewScore: template.manualReviewScore,
        autoRejectScore: template.autoRejectScore,
        reverifyAfterDays: template.reverifyAfterDays,
        screeningConfig: template.screeningConfig as never,
      },
    });
  }

  // --- Queues ---
  const queues = [
    { name: 'manual-review', description: 'General verification review', isDefault: true, sla: 1440 },
    { name: 'aml-hits', description: 'Sanctions, PEP, and adverse media hits', isDefault: false, sla: 480 },
    { name: 'fraud-review', description: 'Suspected fraud and duplicate accounts', isDefault: false, sla: 720 },
    { name: 'edd-review', description: 'Enhanced due diligence', isDefault: false, sla: 2880 },
    { name: 'kyb-review', description: 'Business verification and UBO resolution', isDefault: false, sla: 2880 },
    { name: 'transaction-alerts', description: 'Transaction monitoring alerts', isDefault: false, sla: 240 },
    { name: 'complaints', description: 'Complaints and appeals', isDefault: false, sla: 480 },
  ];
  for (const queue of queues) {
    await prisma.queue.upsert({
      where: { tenantId_name: { tenantId: tenant.id, name: queue.name } },
      create: {
        tenantId: tenant.id,
        name: queue.name,
        description: queue.description,
        isDefault: queue.isDefault,
        slaFirstResponseMinutes: Math.round(queue.sla / 4),
        slaResolutionMinutes: queue.sla,
      },
      update: {},
    });
  }

  // --- Rules ---
  for (const rule of ALL_DEFAULT_RULES) {
    await prisma.rule.upsert({
      where: { tenantId_name: { tenantId: tenant.id, name: rule.name } },
      create: {
        tenantId: tenant.id,
        name: rule.name,
        description: rule.description,
        scope: rule.scope,
        priority: rule.priority,
        isActive: rule.isActive,
        isShadow: rule.isShadow,
        conditions: rule.conditions as never,
        actions: rule.actions as never,
        versions: {
          create: {
            version: 1,
            conditions: rule.conditions as never,
            actions: rule.actions as never,
            changeNote: 'Seeded default',
          },
        },
      },
      update: {
        conditions: rule.conditions as never,
        actions: rule.actions as never,
        priority: rule.priority,
      },
    });
  }
  console.log(`  rules: ${ALL_DEFAULT_RULES.length}`);

  // --- Watchlist corpus ---
  // Chosen so screening has something real to do: an exact sanctions match, a
  // name-only near-match that a correct matcher should down-rank on the date of
  // birth, PEPs at different tiers, and adverse media.
  const watchlist = [
    {
      listType: 'SANCTIONS' as const,
      listName: 'OFAC SDN',
      fullName: 'Viktor Aleksandrovich Petrov',
      aliases: ['V. A. Petrov', 'Viktor Petroff'],
      dob: '1968-03-14',
      countries: ['RUS'],
      program: 'UKRAINE-EO13662',
      remarks: 'Designated under Executive Order 13662.',
    },
    {
      // Same surname, different person: the discriminator is the date of birth,
      // which is exactly the false positive analysts spend their days clearing.
      listType: 'SANCTIONS' as const,
      listName: 'EU Consolidated List',
      fullName: 'Ivan Petrov',
      aliases: [],
      dob: '1955-11-02',
      countries: ['BLR'],
      program: 'BELARUS',
      remarks: 'Common name; corroborate on date of birth before escalating.',
    },
    {
      listType: 'SANCTIONS' as const,
      listName: 'UN 1267 Consolidated',
      fullName: 'Ahmad Khalil Mansour',
      aliases: ['Abu Khalil'],
      yobOnly: 1979,
      countries: ['SYR', 'LBN'],
      program: 'ISIL-AQ',
    },
    {
      listType: 'PEP' as const,
      listName: 'Global PEP Register',
      fullName: 'Helena Voss',
      aliases: ['H. Voss'],
      dob: '1971-06-30',
      countries: ['DEU'],
      positions: ['Minister of Finance'],
      pepTier: 1,
    },
    {
      listType: 'PEP' as const,
      listName: 'Global PEP Register',
      fullName: 'Marcus Lindqvist',
      aliases: [],
      dob: '1980-01-22',
      countries: ['SWE'],
      positions: ['Municipal Council Member, Uppsala'],
      pepTier: 4,
    },
    {
      listType: 'PEP' as const,
      listName: 'Global PEP Register',
      fullName: 'Chen Wei',
      aliases: ['Wei Chen'],
      yobOnly: 1965,
      countries: ['CHN'],
      positions: ['Deputy Director, State Development Bank'],
      pepTier: 2,
    },
    {
      listType: 'ADVERSE_MEDIA' as const,
      listName: 'Adverse Media Screening',
      fullName: 'Tomás Ferreira',
      aliases: [],
      dob: '1974-09-08',
      countries: ['PRT', 'BRA'],
      remarks: 'Named in a 2024 investigation into invoice fraud.',
      categories: ['fraud', 'money-laundering'],
    },
    {
      listType: 'WANTED' as const,
      listName: 'Interpol Red Notices',
      fullName: 'Dmitri Sokolov',
      aliases: ['D. Sokolov'],
      dob: '1985-04-17',
      countries: ['RUS', 'CYP'],
      remarks: 'Wanted in connection with securities fraud.',
    },
    {
      listType: 'DISQUALIFIED_DIRECTOR' as const,
      listName: 'UK Disqualified Directors Register',
      fullName: 'Peter Nowak',
      aliases: [],
      dob: '1969-12-01',
      countries: ['GBR'],
      remarks: 'Disqualified until 2029.',
    },
  ];

  for (const entry of watchlist) {
    const existing = await prisma.watchlistEntry.findFirst({
      where: { fullName: entry.fullName, listName: entry.listName, tenantId: null },
    });
    if (existing) continue;
    await prisma.watchlistEntry.create({
      data: {
        tenantId: null,
        listType: entry.listType,
        listName: entry.listName,
        entityType: 'INDIVIDUAL',
        fullName: entry.fullName,
        aliases: entry.aliases,
        dob: entry.dob ? new Date(entry.dob) : null,
        yobOnly: entry.yobOnly ?? null,
        countries: entry.countries,
        positions: entry.positions ?? [],
        pepTier: entry.pepTier ?? null,
        program: entry.program ?? null,
        remarks: entry.remarks ?? null,
        // Indexed token prefixes are what the candidate pre-filter searches on.
        nameTokens: [
          ...new Set(
            [entry.fullName, ...entry.aliases]
              .flatMap((n) => nameTokens(n))
              .flatMap((t) => [t, t.slice(0, 4)]),
          ),
        ],
        listedAt: new Date('2024-01-15'),
        isActive: true,
        raw: { categories: entry.categories ?? [], source: 'seed' } as never,
      },
    });
  }
  console.log(`  watchlist entries: ${watchlist.length}`);

  // --- Knowledge base for the support agent ---
  const articles = [
    {
      slug: 'photo-quality-tips',
      title: 'How to take a document photo that passes first time',
      intents: ['UPLOAD_HELP', 'DOCUMENT_REJECTED'] as const,
      keywords: ['blurry', 'photo', 'glare', 'upload', 'quality', 'camera', 'dark'],
      body: [
        'Lay the document flat on a dark, non-reflective surface.',
        'Use indirect daylight. Overhead lights and camera flash cause glare that hides the text.',
        'Fill the frame with the document but keep all four corners visible.',
        'Hold still until the camera focuses — most rejections are simply motion blur.',
        'Photograph the physical document. A photo of a screen or a screenshot will be rejected.',
        'If the document has data on the back (most ID cards and driving licences), upload both sides.',
      ].join('\n'),
    },
    {
      slug: 'selfie-and-liveness-help',
      title: 'Getting the selfie check to work',
      intents: ['LIVENESS_FAILURE', 'UPLOAD_HELP'] as const,
      keywords: ['selfie', 'liveness', 'face', 'camera', 'blink', 'glasses', 'hat'],
      body: [
        'Face a window or lamp so your face is evenly lit, with no strong light behind you.',
        'Remove hats, sunglasses, and face coverings. Prescription glasses are usually fine.',
        'Hold the phone at eye level, roughly arm’s length away.',
        'Make sure you are alone in frame — a second face in the background will fail the check.',
        'Follow the on-screen prompts fully; stopping early counts as an incomplete check.',
      ].join('\n'),
    },
    {
      slug: 'how-long-verification-takes',
      title: 'How long verification takes',
      intents: ['TIMELINE_QUESTION', 'VERIFICATION_STATUS'] as const,
      keywords: ['long', 'time', 'waiting', 'when', 'status', 'delay', 'eta'],
      body: [
        'Most verifications finish automatically within a few minutes of submission.',
        'If a person needs to review your application, it usually takes a few hours and up to one working day.',
        'Applications that need extra checks — for example where your name is similar to someone on a sanctions list — take longer, because a specialist reviews them by hand.',
        'You do not need to resubmit while your application is under review. Doing so restarts the queue.',
      ].join('\n'),
    },
    {
      slug: 'proof-of-address-requirements',
      title: 'What counts as proof of address',
      intents: ['UPLOAD_HELP', 'DOCUMENT_REJECTED'] as const,
      keywords: ['address', 'proof', 'utility', 'bill', 'statement', 'residence'],
      body: [
        'We accept a utility bill, bank statement, or official tax document.',
        'It must be dated within the last three months and show your full name and address as you gave them to us.',
        'Mobile phone bills, insurance quotes, and handwritten documents are not accepted.',
        'Upload the whole document, including the letterhead and the date — a cropped screenshot of one line will be rejected.',
      ].join('\n'),
    },
    {
      slug: 'document-expired',
      title: 'My document has expired',
      intents: ['DOCUMENT_REJECTED'] as const,
      keywords: ['expired', 'expiry', 'out of date', 'renew'],
      body: [
        'We can only accept a document that is valid on the day you submit it.',
        'If your passport or ID card has expired, upload a different valid document, or renew it and come back.',
        'Some services require the document to remain valid for a further 30 days, so a document expiring next week may also be declined.',
      ].join('\n'),
    },
    {
      slug: 'why-we-verify-identity',
      title: 'Why we need to verify your identity',
      intents: ['OTHER', 'VERIFICATION_STATUS'] as const,
      keywords: ['why', 'need', 'required', 'legal', 'regulation', 'kyc'],
      body: [
        'Financial regulations require us to confirm the identity of every customer before we can provide services.',
        'We collect the minimum needed to satisfy that obligation, and we tell you what each step is for.',
        'Your documents are stored encrypted and are only accessible to the small number of staff who review applications.',
      ].join('\n'),
    },
  ];

  for (const article of articles) {
    await prisma.knowledgeArticle.upsert({
      where: {
        tenantId_slug_locale: { tenantId: tenant.id, slug: article.slug, locale: 'en' },
      },
      create: {
        tenantId: tenant.id,
        slug: article.slug,
        title: article.title,
        body: article.body,
        intents: article.intents as never[],
        keywords: article.keywords,
        locale: 'en',
      },
      update: { body: article.body, keywords: article.keywords },
    });
  }
  console.log(`  knowledge articles: ${articles.length}`);

  // --- Demo applicants covering the interesting paths ---
  // The mock adapters key off names, so the name chooses the scenario. That is
  // what makes the whole flow demonstrable without any real documents.
  const level = await prisma.verificationLevel.findFirstOrThrow({
    where: { tenantId: tenant.id, name: 'standard-kyc-aml' },
  });

  const applicants = [
    {
      externalUserId: 'demo-clean-001',
      firstName: 'Anna',
      lastName: 'Rossi',
      dob: '1990-05-12',
      country: 'ITA',
      email: 'anna.rossi@example.com',
      note: 'clean path — should auto-approve',
    },
    {
      externalUserId: 'demo-blurry-002',
      firstName: 'Blurry',
      lastName: 'Kowalski',
      dob: '1988-02-03',
      country: 'POL',
      email: 'b.kowalski@example.com',
      note: 'poor capture — retryable rejection',
    },
    {
      externalUserId: 'demo-forged-003',
      firstName: 'Forged',
      lastName: 'Silva',
      dob: '1985-07-21',
      country: 'PRT',
      email: 'f.silva@example.com',
      note: 'tampered document — final rejection',
    },
    {
      externalUserId: 'demo-sanctioned-004',
      firstName: 'Viktor',
      lastName: 'Petrov',
      dob: '1968-03-14',
      country: 'RUS',
      email: 'v.petrov@example.com',
      note: 'exact sanctions match — blocks onboarding',
    },
    {
      externalUserId: 'demo-namesake-005',
      firstName: 'Ivan',
      lastName: 'Petrov',
      dob: '1992-08-19',
      country: 'BGR',
      email: 'ivan.petrov@example.com',
      note: 'name-only match, different date of birth — should be clearable as a false positive',
    },
    {
      externalUserId: 'demo-pep-006',
      firstName: 'Helena',
      lastName: 'Voss',
      dob: '1971-06-30',
      country: 'DEU',
      email: 'h.voss@example.com',
      note: 'tier 1 PEP — enhanced due diligence',
    },
    {
      externalUserId: 'demo-spoof-007',
      firstName: 'Spoof',
      lastName: 'Nakamura',
      dob: '1995-11-30',
      country: 'JPN',
      email: 'spoof@example.com',
      note: 'presentation attack — final rejection',
    },
  ];

  for (const applicant of applicants) {
    await prisma.applicant.upsert({
      where: {
        tenantId_externalUserId: { tenantId: tenant.id, externalUserId: applicant.externalUserId },
      },
      create: {
        tenantId: tenant.id,
        externalUserId: applicant.externalUserId,
        levelId: level.id,
        firstName: applicant.firstName,
        lastName: applicant.lastName,
        dob: new Date(applicant.dob),
        country: applicant.country,
        nationality: applicant.country,
        email: applicant.email,
        ipAddress: '81.2.69.142',
        userAgent:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
        metadata: { seedNote: applicant.note } as never,
      },
      update: {},
    });
  }
  console.log(`  demo applicants: ${applicants.length}`);

  // --- A webhook endpoint pointed at a local sink ---
  const existingHook = await prisma.webhookEndpoint.findFirst({
    where: { tenantId: tenant.id },
  });
  if (!existingHook) {
    await prisma.webhookEndpoint.create({
      data: {
        tenantId: tenant.id,
        url: 'http://localhost:4999/webhooks',
        description: 'Local development sink',
        eventTypes: [],
        secret: newSecret(32),
        environment: 'SANDBOX',
      },
    });
  }

  console.log('\nSeed complete.');
  console.log(`\n  Tenant:    ${tenant.name} (${tenant.slug})`);
  console.log(`  Dashboard: any of the accounts below, password "${password}"`);
  for (const user of users) console.log(`               ${user.email.padEnd(26)} ${user.role}`);
  if (apiCredentials) {
    console.log(`\n  API key:   ${apiCredentials.keyId}`);
    console.log(`  API secret: ${apiCredentials.secret}`);
    console.log('  (the secret is shown once — copy it now)');
  }
  console.log('\n  Try: POST /v1/applicants/<id>/submit for demo-clean-001 vs demo-forged-003.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

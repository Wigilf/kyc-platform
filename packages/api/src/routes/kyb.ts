import type { FastifyPluginAsync } from 'fastify';
import {
  AddOwnershipEdgeSchema,
  COMPANY_RULES,
  CreateCompanySchema,
  describeOwnership,
  evaluateRules,
  notFound,
  resolveUbos,
  sanctionedOwnershipPercent,
  summarizeActions,
  uboFacts,
  type OwnershipEdgeInput,
} from '@kyc/core';
import { prisma } from '@kyc/db';
import { adaptersFor, enqueueScreening } from '@kyc/worker';
import { requireBackend, requireRole, writeAudit } from '../auth.js';

/**
 * KYB: companies, registry lookups, and the ownership graph.
 *
 * The interesting endpoint is `/ubo`, which resolves the graph rather than just
 * listing declared shareholders. Two things it does that a naive implementation
 * misses: it aggregates a person's stakes across multiple paths (15% direct plus
 * 15% via a holding company is a 30% beneficial owner), and it reports
 * *unresolved* ownership explicitly instead of quietly ignoring chains that do
 * not terminate in a natural person.
 */

const kybRoutes: FastifyPluginAsync = async (app) => {
  // --- Create a company and run the registry lookup ---
  app.post('/v1/companies', async (request, reply) => {
    const caller = requireBackend(request);
    const body = CreateCompanySchema.parse(request.body);

    const level = await prisma.verificationLevel.findFirst({
      where: {
        tenantId: caller.tenantId,
        name: body.levelName,
        isActive: true,
        subjectType: 'COMPANY',
      },
      orderBy: { version: 'desc' },
    });
    if (!level) throw notFound('Company verification level', body.levelName);

    const company = await prisma.company.upsert({
      where: {
        tenantId_country_registrationNumber: {
          tenantId: caller.tenantId,
          country: body.country,
          registrationNumber: body.registrationNumber ?? '',
        },
      },
      create: {
        tenantId: caller.tenantId,
        legalName: body.legalName,
        tradingName: body.tradingName,
        registrationNumber: body.registrationNumber ?? '',
        taxId: body.taxId,
        lei: body.lei,
        country: body.country,
        jurisdiction: body.jurisdiction,
        legalForm: body.legalForm,
        incorporatedAt: body.incorporatedAt ? new Date(body.incorporatedAt) : null,
        registeredAddress: (body.registeredAddress ?? {}) as never,
        website: body.website,
        industryCodes: body.industryCodes,
      },
      update: { legalName: body.legalName, tradingName: body.tradingName },
    });

    // The applicant record is what carries the verification lifecycle; the company
    // record carries the corporate facts. One relationship, two shapes.
    const applicant = await prisma.applicant.upsert({
      where: {
        tenantId_externalUserId: {
          tenantId: caller.tenantId,
          externalUserId: body.externalUserId,
        },
      },
      create: {
        tenantId: caller.tenantId,
        externalUserId: body.externalUserId,
        levelId: level.id,
        subjectType: 'COMPANY',
        companyId: company.id,
        country: body.country,
      },
      update: { companyId: company.id },
    });

    // Registry lookup: the authoritative source for everything the client told us.
    const registry = await adaptersFor(caller.tenantId).registry.lookup(
      {
        country: body.country,
        registrationNumber: body.registrationNumber,
        legalName: body.legalName,
      },
      { tenantId: caller.tenantId },
    );

    if (registry.ok && registry.data?.found) {
      const data = registry.data;
      await prisma.companyRegistryRecord.create({
        data: {
          companyId: company.id,
          registry: data.registry,
          payload: data as never,
        },
      });

      await prisma.company.update({
        where: { id: company.id },
        data: {
          status: data.status as never,
          legalForm: data.legalForm ?? company.legalForm,
          incorporatedAt: data.incorporatedAt ? new Date(data.incorporatedAt) : company.incorporatedAt,
          registeredAddress: (data.registeredAddress ?? company.registeredAddress) as never,
          industryCodes: data.industryCodes.length ? data.industryCodes : company.industryCodes,
        },
      });

      // Officers become positions, each of which needs screening in its own right —
      // screening the entity alone misses a sanctioned director.
      for (const officer of data.officers) {
        await prisma.companyPosition.create({
          data: {
            companyId: company.id,
            role: officer.role as never,
            fullName: officer.fullName,
            dob: officer.dob ? new Date(officer.dob) : null,
            country: officer.country,
            appointedAt: officer.appointedAt ? new Date(officer.appointedAt) : null,
            isActive: !officer.resignedAt,
          },
        });
      }

      // Shareholders become ownership edges. A corporate shareholder creates a
      // child company node so the chain can be walked further.
      for (const holder of data.shareholders) {
        if (holder.isCompany) {
          const parent = await prisma.company.upsert({
            where: {
              tenantId_country_registrationNumber: {
                tenantId: caller.tenantId,
                country: holder.country ?? body.country,
                registrationNumber: holder.registrationNumber ?? holder.name,
              },
            },
            create: {
              tenantId: caller.tenantId,
              legalName: holder.name,
              registrationNumber: holder.registrationNumber ?? holder.name,
              country: holder.country ?? body.country,
            },
            update: {},
          });
          await prisma.ownershipEdge.create({
            data: {
              childId: company.id,
              parentCompanyId: parent.id,
              ownershipPercent: holder.ownershipPercent,
              votingPercent: holder.votingPercent,
              isNominee: holder.isNominee ?? false,
              source: 'registry',
              verifiedAt: new Date(),
            },
          });
        } else {
          await prisma.ownershipEdge.create({
            data: {
              childId: company.id,
              parentPersonName: holder.name,
              parentPersonDob: holder.dob ? new Date(holder.dob) : null,
              parentPersonCountry: holder.country,
              ownershipPercent: holder.ownershipPercent,
              votingPercent: holder.votingPercent,
              isNominee: holder.isNominee ?? false,
              source: 'registry',
              verifiedAt: new Date(),
            },
          });
        }
      }
    }

    await enqueueScreening({
      tenantId: caller.tenantId,
      companyId: company.id,
      trigger: 'INITIAL',
      listTypes: ['SANCTIONS', 'PEP', 'ADVERSE_MEDIA', 'REGULATORY_ENFORCEMENT'],
    });

    await writeAudit(request, {
      action: 'company.created',
      resourceType: 'Company',
      resourceId: company.id,
      after: { legalName: company.legalName, registryFound: registry.data?.found ?? false },
    });

    return reply.status(201).send({
      company: { id: company.id, legalName: company.legalName, status: company.status },
      applicantId: applicant.id,
      registry: registry.data?.found
        ? {
            found: true,
            registry: registry.data.registry,
            status: registry.data.status,
            officers: registry.data.officers.length,
            shareholders: registry.data.shareholders.length,
            substance: registry.data.substance,
            findings: registry.data.findings,
          }
        : { found: false, findings: registry.data?.findings ?? [] },
    });
  });

  // --- Add an ownership edge manually ---
  app.post('/v1/companies/ownership', async (request, reply) => {
    const user = requireRole(request, 'AGENT');
    const body = AddOwnershipEdgeSchema.parse(request.body);

    await prisma.company.findFirstOrThrow({
      where: { id: body.childCompanyId, tenantId: user.tenantId },
    });

    const edge = await prisma.ownershipEdge.create({
      data: {
        childId: body.childCompanyId,
        parentCompanyId: body.parentCompanyId,
        parentPersonName: body.parentPersonName,
        parentPersonDob: body.parentPersonDob ? new Date(body.parentPersonDob) : null,
        parentPersonCountry: body.parentPersonCountry,
        ownershipPercent: body.ownershipPercent,
        votingPercent: body.votingPercent,
        controlType: body.controlType as never,
        isNominee: body.isNominee,
        source: body.source ?? 'manual',
      },
    });

    await writeAudit(request, {
      action: 'ownership.edge.added',
      resourceType: 'OwnershipEdge',
      resourceId: edge.id,
      after: {
        childId: body.childCompanyId,
        percent: body.ownershipPercent,
        parent: body.parentCompanyId ?? body.parentPersonName,
      },
    });

    return reply.status(201).send({ edge });
  });

  // --- Resolve the UBO graph ---
  app.get<{ Params: { id: string }; Querystring: { threshold?: string; maxDepth?: string } }>(
    '/v1/companies/:id/ubo',
    async (request) => {
      const caller = requireBackend(request);
      const root = await prisma.company.findFirstOrThrow({
        where: { id: request.params.id, tenantId: caller.tenantId },
      });

      // Load the whole tenant subgraph once. Walking edge-by-edge with a query per
      // hop would be N+1 across a structure that is usually small enough to hold.
      const companies = await prisma.company.findMany({
        where: { tenantId: caller.tenantId },
        select: { id: true, legalName: true, country: true },
      });
      const edges = await prisma.ownershipEdge.findMany({
        where: { child: { tenantId: caller.tenantId } },
      });

      const resolution = resolveUbos(
        {
          rootCompanyId: root.id,
          companies: companies.map((c) => ({
            kind: 'company' as const,
            id: c.id,
            legalName: c.legalName,
            country: c.country,
          })),
          edges: edges.map(
            (e): OwnershipEdgeInput => ({
              childId: e.childId,
              parentCompanyId: e.parentCompanyId,
              parentPersonName: e.parentPersonName,
              parentPersonDob: e.parentPersonDob?.toISOString().slice(0, 10) ?? null,
              parentPersonCountry: e.parentPersonCountry,
              ownershipPercent: e.ownershipPercent,
              votingPercent: e.votingPercent,
              controlType: e.controlType,
              isNominee: e.isNominee,
            }),
          ),
        },
        {
          thresholdPercent: Number(request.query.threshold ?? 25),
          maxDepth: Number(request.query.maxDepth ?? 6),
        },
      );

      // Which resolved owners are on a watchlist? The 50% rule means aggregated
      // sanctioned ownership can make the entity itself sanctioned.
      const listed = await prisma.watchlistEntry.findMany({
        where: {
          listType: 'SANCTIONS',
          isActive: true,
          OR: [{ tenantId: null }, { tenantId: caller.tenantId }],
        },
        select: { fullName: true, aliases: true },
      });
      const { nameSimilarity } = await import('@kyc/core');
      const sanctionedPercent = sanctionedOwnershipPercent(resolution, (person) =>
        listed.some(
          (entry) =>
            nameSimilarity(person.name, entry.fullName) >= 0.9 ||
            entry.aliases.some((a) => nameSimilarity(person.name, a) >= 0.9),
        ),
      );

      const facts = {
        company: {
          ...uboFacts(resolution),
          status: root.status,
          sanctionedOwnershipPercent: sanctionedPercent,
          offshoreLayerCount: resolution.offshoreLayerCount,
        },
      };
      const evaluation = evaluateRules(COMPANY_RULES, facts, { scope: 'COMPANY' });
      const hints = summarizeActions(evaluation.actions);

      await prisma.company.update({
        where: { id: root.id },
        data: {
          uboUnresolved: resolution.unresolvedPercent >= 1,
          uboDepth: resolution.maxDepth,
        },
      });

      return {
        company: { id: root.id, legalName: root.legalName, status: root.status },
        ubos: resolution.ubos,
        minorityHolders: resolution.minorityHolders,
        // Reported loudly rather than omitted: unresolved ownership is the finding.
        unresolved: {
          percent: resolution.unresolvedPercent,
          nodes: resolution.unresolvedNodes,
        },
        structure: {
          maxDepth: resolution.maxDepth,
          offshoreLayerCount: resolution.offshoreLayerCount,
          hasNomineeShareholders: resolution.hasNomineeShareholders,
          circularOwnership: resolution.cycles,
          rootDeclaredPercent: resolution.rootDeclaredPercent,
          registerIncomplete: resolution.rootDeclaredPercent < 99.5,
        },
        sanctionedOwnershipPercent: sanctionedPercent,
        assessment: {
          firedRules: evaluation.fired.filter((f) => !f.isShadow).map((f) => f.ruleName),
          requiresManualReview: hints.requiresManualReview,
          requiresEdd: hints.requiresEdd,
          autoReject: hints.autoReject,
          rejectLabels: hints.rejectLabels,
          requestedDocuments: hints.requestedDocuments,
        },
        // Human-readable chain for the case file.
        narrative: describeOwnership(resolution),
      };
    },
  );

  app.get<{ Params: { id: string } }>('/v1/companies/:id', async (request) => {
    const caller = requireBackend(request);
    const company = await prisma.company.findFirstOrThrow({
      where: { id: request.params.id, tenantId: caller.tenantId },
      include: {
        positions: { where: { isActive: true } },
        registryRecords: { orderBy: { fetchedAt: 'desc' }, take: 1 },
        screeningRuns: { orderBy: { startedAt: 'desc' }, take: 1, include: { hits: true } },
        ownedBy: true,
      },
    });
    return { company };
  });
};

export default kybRoutes;

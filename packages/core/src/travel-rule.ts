import { z } from 'zod';

/**
 * FATF Recommendation 16 ("Travel Rule") support.
 *
 * Obligation: for a virtual-asset transfer at or above the local threshold, the
 * originating VASP must send originator and beneficiary identity data to the
 * receiving VASP, and the receiver must be able to act on what it gets.
 *
 * The interchange format is IVMS101. It is verbose and deeply nested by design —
 * it has to express names in multiple scripts and a dozen national ID types — so
 * this module keeps a narrow, validated subset and converts to and from our own
 * flat shape.
 */

/** Thresholds in the local reporting currency, by jurisdiction. */
export const TRAVEL_RULE_THRESHOLDS: Record<string, { amount: number; currency: string }> = {
  USA: { amount: 3000, currency: 'USD' },
  // The EU Transfer of Funds Regulation applies with no de minimis for crypto.
  EUR: { amount: 0, currency: 'EUR' },
  DEU: { amount: 0, currency: 'EUR' },
  FRA: { amount: 0, currency: 'EUR' },
  NLD: { amount: 0, currency: 'EUR' },
  GBR: { amount: 1000, currency: 'GBP' },
  CHE: { amount: 0, currency: 'CHF' },
  SGP: { amount: 1500, currency: 'SGD' },
  JPN: { amount: 100000, currency: 'JPY' },
  CAN: { amount: 1000, currency: 'CAD' },
  AUS: { amount: 3000, currency: 'AUD' },
  ARE: { amount: 3500, currency: 'AED' },
  ZAF: { amount: 5000, currency: 'ZAR' },
  DEFAULT: { amount: 1000, currency: 'EUR' },
};

export function thresholdFor(jurisdiction: string): { amount: number; currency: string } {
  return (
    TRAVEL_RULE_THRESHOLDS[jurisdiction.toUpperCase()] ??
    TRAVEL_RULE_THRESHOLDS.DEFAULT!
  );
}

export function isTravelRuleRequired(args: {
  jurisdiction: string;
  amountBase: number;
  baseCurrency: string;
  isCrypto: boolean;
  /** Self-hosted wallet transfers have different (often stricter) obligations. */
  counterpartyIsVasp: boolean;
}): { required: boolean; reason: string; threshold: number } {
  const { amount, currency } = thresholdFor(args.jurisdiction);
  if (!args.isCrypto) {
    return { required: false, reason: 'not a virtual asset transfer', threshold: amount };
  }
  if (!args.counterpartyIsVasp) {
    // No counterparty VASP to send to, but the originator still has to collect
    // and retain the data and risk-assess the self-hosted wallet.
    return {
      required: false,
      reason: 'counterparty is a self-hosted wallet; collect and retain, no exchange',
      threshold: amount,
    };
  }
  if (currency !== args.baseCurrency) {
    // Comparing across currencies without an FX rate would be guesswork; treat
    // as required and let a human confirm rather than under-report.
    return {
      required: true,
      reason: `threshold is in ${currency} but amount is in ${args.baseCurrency}; defaulting to required`,
      threshold: amount,
    };
  }
  if (args.amountBase >= amount) {
    return {
      required: true,
      reason: `${args.amountBase} ${args.baseCurrency} ≥ ${amount} ${currency}`,
      threshold: amount,
    };
  }
  return {
    required: false,
    reason: `below the ${amount} ${currency} threshold`,
    threshold: amount,
  };
}

// ---------------------------------------------------------------------------
// IVMS101 subset
// ---------------------------------------------------------------------------

const NaturalPersonNameId = z.object({
  primaryIdentifier: z.string().min(1), // surname
  secondaryIdentifier: z.string().optional(), // given names
  nameIdentifierType: z
    .enum(['ALIA', 'BIRT', 'MAID', 'LEGL', 'MISC'])
    .default('LEGL'),
});

const Address = z.object({
  addressType: z.enum(['HOME', 'BIZZ', 'GEOG']).default('HOME'),
  addressLine: z.array(z.string()).optional(),
  street: z.string().optional(),
  buildingNumber: z.string().optional(),
  postCode: z.string().optional(),
  townName: z.string().optional(),
  countrySubDivision: z.string().optional(),
  country: z.string().length(2), // IVMS101 uses ISO 3166-1 alpha-2
});

const NationalIdentification = z.object({
  nationalIdentifier: z.string().min(1),
  nationalIdentifierType: z.enum([
    'ARNU', // alien registration
    'CCPT', // passport
    'RAID', // registration authority
    'DRLC', // driving licence
    'FIIN', // foreign investment id
    'TXID', // tax id
    'SOCS', // social security
    'IDCD', // national identity card
    'LEIX', // LEI
    'MISC',
  ]),
  registrationAuthority: z.string().optional(),
  countryOfIssue: z.string().length(2).optional(),
});

export const NaturalPersonSchema = z.object({
  name: z.array(NaturalPersonNameId).min(1),
  address: z.array(Address).optional(),
  nationalIdentification: NationalIdentification.optional(),
  customerIdentification: z.string().optional(),
  dateAndPlaceOfBirth: z
    .object({
      dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      placeOfBirth: z.string(),
    })
    .optional(),
  countryOfResidence: z.string().length(2).optional(),
});

export const LegalPersonSchema = z.object({
  name: z.array(
    z.object({
      legalPersonName: z.string().min(1),
      legalPersonNameIdentifierType: z
        .enum(['LEGL', 'SHRT', 'TRAD'])
        .default('LEGL'),
    }),
  ),
  address: z.array(Address).optional(),
  nationalIdentification: NationalIdentification.optional(),
  customerNumber: z.string().optional(),
  countryOfRegistration: z.string().length(2).optional(),
});

export const PersonSchema = z.union([
  z.object({ naturalPerson: NaturalPersonSchema }),
  z.object({ legalPerson: LegalPersonSchema }),
]);

export const OriginatorSchema = z.object({
  originatorPersons: z.array(PersonSchema).min(1),
  accountNumber: z.array(z.string()).min(1), // wallet address(es)
});

export const BeneficiarySchema = z.object({
  beneficiaryPersons: z.array(PersonSchema).min(1),
  accountNumber: z.array(z.string()).min(1),
});

export const IvmsPayloadSchema = z.object({
  originator: OriginatorSchema,
  beneficiary: BeneficiarySchema,
  originatingVasp: z.object({ vasp: PersonSchema }).optional(),
  beneficiaryVasp: z.object({ vasp: PersonSchema }).optional(),
  transferPath: z
    .object({
      assetType: z.string(),
      amount: z.string(),
      transactionHash: z.string().optional(),
      network: z.string().optional(),
    })
    .optional(),
});

export type IvmsPayload = z.infer<typeof IvmsPayloadSchema>;

/** Our flat internal representation, which the API and dashboard speak. */
export interface TravelRuleParty {
  type: 'NATURAL' | 'LEGAL';
  firstName?: string;
  lastName?: string;
  legalName?: string;
  dateOfBirth?: string;
  placeOfBirth?: string;
  addressLine?: string;
  city?: string;
  postCode?: string;
  countryAlpha2: string;
  nationalIdType?: string;
  nationalId?: string;
  customerNumber?: string;
  walletAddress: string;
}

export function toIvms101(args: {
  originator: TravelRuleParty;
  beneficiary: TravelRuleParty;
  assetType: string;
  amount: string;
  network?: string;
  transactionHash?: string;
}): IvmsPayload {
  const person = (p: TravelRuleParty) =>
    p.type === 'NATURAL'
      ? {
          naturalPerson: {
            name: [
              {
                primaryIdentifier: p.lastName ?? '',
                secondaryIdentifier: p.firstName,
                nameIdentifierType: 'LEGL' as const,
              },
            ],
            ...(p.addressLine || p.city
              ? {
                  address: [
                    {
                      addressType: 'HOME' as const,
                      addressLine: p.addressLine ? [p.addressLine] : undefined,
                      townName: p.city,
                      postCode: p.postCode,
                      country: p.countryAlpha2,
                    },
                  ],
                }
              : {}),
            ...(p.nationalId && p.nationalIdType
              ? {
                  nationalIdentification: {
                    nationalIdentifier: p.nationalId,
                    nationalIdentifierType: p.nationalIdType as 'CCPT',
                    countryOfIssue: p.countryAlpha2,
                  },
                }
              : {}),
            ...(p.dateOfBirth && p.placeOfBirth
              ? {
                  dateAndPlaceOfBirth: {
                    dateOfBirth: p.dateOfBirth,
                    placeOfBirth: p.placeOfBirth,
                  },
                }
              : {}),
            customerIdentification: p.customerNumber,
            countryOfResidence: p.countryAlpha2,
          },
        }
      : {
          legalPerson: {
            name: [
              {
                legalPersonName: p.legalName ?? '',
                legalPersonNameIdentifierType: 'LEGL' as const,
              },
            ],
            countryOfRegistration: p.countryAlpha2,
            customerNumber: p.customerNumber,
          },
        };

  return IvmsPayloadSchema.parse({
    originator: {
      originatorPersons: [person(args.originator)],
      accountNumber: [args.originator.walletAddress],
    },
    beneficiary: {
      beneficiaryPersons: [person(args.beneficiary)],
      accountNumber: [args.beneficiary.walletAddress],
    },
    transferPath: {
      assetType: args.assetType,
      amount: args.amount,
      network: args.network,
      transactionHash: args.transactionHash,
    },
  });
}

/**
 * Sufficiency check on an inbound payload. A receiving VASP must be able to tell
 * whether it got enough to screen the counterparty; "a name and nothing else"
 * is a compliance failure on the sender's side that the receiver has to record.
 */
export function validateInboundPayload(payload: unknown): {
  valid: boolean;
  sufficient: boolean;
  missing: string[];
  errors: string[];
} {
  const parsed = IvmsPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      valid: false,
      sufficient: false,
      missing: [],
      errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    };
  }

  const missing: string[] = [];
  const originator = parsed.data.originator.originatorPersons[0];

  if (originator && 'naturalPerson' in originator) {
    const np = originator.naturalPerson;
    if (!np.name[0]?.secondaryIdentifier) missing.push('originator.givenNames');
    if (!np.address?.length) missing.push('originator.address');
    // Either an address or a national identifier is required; a bare name is not
    // enough to screen against a watchlist with any confidence.
    if (!np.nationalIdentification && !np.dateAndPlaceOfBirth) {
      missing.push('originator.nationalIdentification-or-dateOfBirth');
    }
  }
  if (!parsed.data.originator.accountNumber[0]) missing.push('originator.accountNumber');

  return {
    valid: true,
    sufficient: missing.length === 0,
    missing,
    errors: [],
  };
}

export const SUPPORTED_PROTOCOLS = ['TRP', 'TRISA', 'OPENVASP', 'SHYFT', 'MANUAL'] as const;
export type TravelRuleProtocol = (typeof SUPPORTED_PROTOCOLS)[number];

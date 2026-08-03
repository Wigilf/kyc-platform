import { redactPii } from '@kyc/core';
import type { NotificationAdapter } from './types.js';

/**
 * Outbound applicant communication.
 *
 * Two properties matter beyond delivery:
 *  - Every message is recorded, because "we told them why" is a compliance
 *    position that has to be evidenced, and because the support agent needs to
 *    know what the applicant has already been told.
 *  - Message bodies are redacted before they reach a log. An email body quoting
 *    a rejection reason can carry a document number.
 */

export interface SentMessage {
  messageId: string;
  channel: 'email' | 'sms';
  to: string;
  subject?: string;
  body: string;
  template?: string;
  sentAt: Date;
}

/** Development driver: records messages and prints a redacted line. */
export class ConsoleNotificationAdapter implements NotificationAdapter {
  readonly name = 'console';
  readonly sent: SentMessage[] = [];

  constructor(private readonly log: (msg: string) => void = console.log) {}

  async sendEmail(args: {
    to: string;
    subject: string;
    body: string;
    template?: string;
    variables?: Record<string, unknown>;
  }) {
    const messageId = `mock-email-${this.sent.length + 1}`;
    this.sent.push({
      messageId,
      channel: 'email',
      to: args.to,
      subject: args.subject,
      body: args.body,
      template: args.template,
      sentAt: new Date(),
    });
    this.log(
      `[email → ${redactPii(args.to).redacted}] ${args.subject} :: ${redactPii(args.body).redacted.slice(0, 160)}`,
    );
    return { messageId };
  }

  async sendSms(args: { to: string; body: string }) {
    const messageId = `mock-sms-${this.sent.length + 1}`;
    this.sent.push({
      messageId,
      channel: 'sms',
      to: args.to,
      body: args.body,
      sentAt: new Date(),
    });
    this.log(`[sms → ${redactPii(args.to).redacted}] ${redactPii(args.body).redacted.slice(0, 120)}`);
    return { messageId };
  }
}

/**
 * Applicant-facing message templates.
 *
 * Kept here rather than inline at call sites so that the wording an applicant
 * receives is reviewable in one place — which is what a compliance team will ask
 * for, since these texts are the firm's communication of an adverse decision.
 */
export const TEMPLATES = {
  'verification.action-required': {
    subject: 'We need one more thing to verify your identity',
    body: (v: { firstName?: string; reasons: string[]; link: string }) =>
      [
        `Hi${v.firstName ? ` ${v.firstName}` : ''},`,
        '',
        'We could not complete your identity verification yet. Here is what to fix:',
        ...v.reasons.map((r) => `  • ${r}`),
        '',
        `You can pick up where you left off here: ${v.link}`,
        '',
        'If something is not clear, reply to this message and we will help.',
      ].join('\n'),
  },
  'verification.approved': {
    subject: 'Your identity has been verified',
    body: (v: { firstName?: string }) =>
      [
        `Hi${v.firstName ? ` ${v.firstName}` : ''},`,
        '',
        'Your identity has been verified. Nothing further is needed from you.',
      ].join('\n'),
  },
  'verification.declined': {
    subject: 'About your identity verification',
    body: (v: { firstName?: string; message: string; supportEmail: string }) =>
      [
        `Hi${v.firstName ? ` ${v.firstName}` : ''},`,
        '',
        v.message,
        '',
        // Never state the internal reason for a fraud or sanctions decline, but
        // always give a route to contest it: that route is a legal requirement in
        // several jurisdictions, and refusing to explain without offering one is
        // what turns a decline into a complaint.
        `If you believe this is wrong, contact ${v.supportEmail} and a member of our team will review it.`,
      ].join('\n'),
  },
  'verification.reminder': {
    subject: 'Your verification is still waiting on you',
    body: (v: { firstName?: string; outstanding: string[]; link: string }) =>
      [
        `Hi${v.firstName ? ` ${v.firstName}` : ''},`,
        '',
        'You started verifying your identity but did not finish. Still outstanding:',
        ...v.outstanding.map((s) => `  • ${s}`),
        '',
        `Continue here: ${v.link}`,
      ].join('\n'),
  },
  'support.escalated': {
    subject: 'Your question has been passed to a specialist',
    body: (v: { firstName?: string; reference: string; etaHours: number }) =>
      [
        `Hi${v.firstName ? ` ${v.firstName}` : ''},`,
        '',
        `Your question (reference ${v.reference}) needs a person rather than our automated assistant.`,
        `Someone will get back to you within ${v.etaHours} hours.`,
      ].join('\n'),
  },
} as const;

export type TemplateName = keyof typeof TEMPLATES;

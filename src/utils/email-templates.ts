import type { NotificationEventType } from "../schemas/notifications.js";
import { config } from "../config.js";

// ---------------------------------------------------------------------------
// Email templates (#1044)
// ---------------------------------------------------------------------------
// Plain-text + HTML for the milestone-lifecycle notifications and for the
// double-opt-in confirmation email. Templates are pure: every URL is passed in
// by the caller. Every notification email carries the one-click unsubscribe
// link; the confirmation email carries the confirmation link.

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export interface NotificationEmailContext {
  contractId: string;
  /** One-click unsubscribe URL, already absolute. */
  unsubscribeUrl: string;
  milestoneIndex?: number;
  /** Optional human-readable extra detail (amount, actor, ...). */
  summary?: string;
}

interface NotificationCopy {
  subject: (ctx: NotificationEmailContext) => string;
  headline: string;
  body: (ctx: NotificationEmailContext) => string;
}

const MILESTONE_LABEL = (index?: number): string =>
  index === undefined ? "A milestone" : `Milestone #${index}`;

const COPY: Record<NotificationEventType, NotificationCopy> = {
  delivered: {
    headline: "Work delivered",
    subject: (ctx) => `${MILESTONE_LABEL(ctx.milestoneIndex)} was delivered`,
    body: (ctx) =>
      `${MILESTONE_LABEL(ctx.milestoneIndex)} on contract ${ctx.contractId} has been delivered and is awaiting approval.`,
  },
  approved: {
    headline: "Milestone approved",
    subject: (ctx) => `${MILESTONE_LABEL(ctx.milestoneIndex)} was approved`,
    body: (ctx) =>
      `${MILESTONE_LABEL(ctx.milestoneIndex)} on contract ${ctx.contractId} has been approved.`,
  },
  disputed: {
    headline: "Milestone disputed",
    subject: (ctx) => `${MILESTONE_LABEL(ctx.milestoneIndex)} was disputed`,
    body: (ctx) =>
      `${MILESTONE_LABEL(ctx.milestoneIndex)} on contract ${ctx.contractId} has been disputed and now needs resolution.`,
  },
  auto_release_available: {
    headline: "Auto-release available",
    subject: (ctx) => `Auto-release is available for ${MILESTONE_LABEL(ctx.milestoneIndex).toLowerCase()}`,
    body: (ctx) =>
      `${MILESTONE_LABEL(ctx.milestoneIndex)} on contract ${ctx.contractId} has reached its auto-release window and can now be released.`,
  },
};

/** Escape the small set of characters that matter inside HTML text nodes. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Absolute confirmation link for a subscription token. */
export function buildConfirmUrl(token: string): string {
  return `${config.emailPublicBaseUrl}/api/notifications/email/confirm?token=${encodeURIComponent(token)}`;
}

/** Absolute one-click unsubscribe link for a subscription token. */
export function buildUnsubscribeUrl(token: string): string {
  return `${config.emailPublicBaseUrl}/unsubscribe?token=${encodeURIComponent(token)}`;
}

/** Render one lifecycle notification (text + HTML, both incl. unsubscribe). */
export function renderNotificationEmail(
  type: NotificationEventType,
  ctx: NotificationEmailContext,
): RenderedEmail {
  const copy = COPY[type];
  const subject = copy.subject(ctx);
  const bodyLines = [copy.body(ctx)];
  if (ctx.summary) bodyLines.push(ctx.summary);
  bodyLines.push(
    "",
    `Manage or unsubscribe from these notifications: ${ctx.unsubscribeUrl}`,
  );
  const text = bodyLines.join("\n");

  const html = [
    `<h2>${escapeHtml(copy.headline)}</h2>`,
    `<p>${escapeHtml(copy.body(ctx))}</p>`,
    ctx.summary ? `<p>${escapeHtml(ctx.summary)}</p>` : "",
    `<p style="font-size:12px;color:#666">`,
    `You are receiving this because you subscribed to updates for contract `,
    `<code>${escapeHtml(ctx.contractId)}</code>. `,
    `<a href="${escapeHtml(ctx.unsubscribeUrl)}">Unsubscribe</a>.`,
    `</p>`,
  ]
    .filter(Boolean)
    .join("\n");

  return { subject, text, html };
}

export interface ConfirmationEmailContext {
  contractId: string;
  /** Absolute URL the recipient must open to confirm the subscription. */
  confirmUrl: string;
  /** Unsubscribe URL so a mis-addressed signup can be cancelled immediately. */
  unsubscribeUrl: string;
}

/** Render the double-opt-in confirmation email. */
export function renderConfirmationEmail(
  ctx: ConfirmationEmailContext,
): RenderedEmail {
  const subject = `Confirm your notification subscription for contract ${ctx.contractId}`;
  const text = [
    `Confirm your email notifications for contract ${ctx.contractId}.`,
    "",
    `Confirm: ${ctx.confirmUrl}`,
    "",
    `If you did not request this, ignore this email — nothing will be sent`,
    `until it is confirmed. To opt out immediately: ${ctx.unsubscribeUrl}`,
  ].join("\n");

  const html = [
    `<h2>Confirm your notification subscription</h2>`,
    `<p>Confirm your email notifications for contract `,
    `<code>${escapeHtml(ctx.contractId)}</code>.</p>`,
    `<p><a href="${escapeHtml(ctx.confirmUrl)}">Confirm subscription</a></p>`,
    `<p style="font-size:12px;color:#666">`,
    `If you did not request this, ignore this email — nothing will be sent `,
    `until it is confirmed. `,
    `<a href="${escapeHtml(ctx.unsubscribeUrl)}">Opt out</a>.`,
    `</p>`,
  ].join("\n");

  return { subject, text, html };
}

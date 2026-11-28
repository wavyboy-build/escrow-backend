import { config } from "../config.js";
import logger from "../utils/logger.js";
import { formatError } from "../utils/format-error.js";
import { isEmailNotificationsEnabled, sendMail } from "../utils/mail.js";
import {
  buildUnsubscribeUrl,
  renderNotificationEmail,
} from "../utils/email-templates.js";
import type { NotificationEventType } from "../schemas/notifications.js";
import {
  getConfirmedEmailSubscriptions,
  getDb,
  type EmailSubscription,
  type EventDbRow,
} from "./db.js";

// ---------------------------------------------------------------------------
// Per-contract email delivery pipeline (#1044)
// ---------------------------------------------------------------------------
// Hooks into the indexed-event feed the same way webhooks do, but runs on its
// own queue so a slow SMTP server never blocks indexing or webhook delivery.
// Only *confirmed* subscriptions receive mail, and only for events whose
// contract discriminator maps to a subscribed notification type.

/**
 * Contract event discriminator -> public notification label. `claim` is the
 * on-chain milestone release (usually reached through auto-release), surfaced
 * to subscribers as "auto-release available".
 */
export const CONTRACT_EVENT_TO_NOTIFICATION: Record<string, NotificationEventType> = {
  deliver: "delivered",
  approve: "approved",
  dispute: "disputed",
  claim: "auto_release_available",
};

/** Public notification label for a contract event, or null when unmapped. */
export function notificationTypeForEvent(
  eventType: string,
): NotificationEventType | null {
  return CONTRACT_EVENT_TO_NOTIFICATION[eventType] ?? null;
}

/** Parse a stored `event_types` value into a list of labels (or ["*"]). */
function parseSubscribedTypes(raw: string): string[] {
  if (raw === "*") return ["*"];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is string => typeof t === "string");
  } catch {
    return [];
  }
}

function subscriptionWants(
  subscription: EmailSubscription,
  type: NotificationEventType,
): boolean {
  const types = parseSubscribedTypes(subscription.event_types);
  return types.includes("*") || types.includes(type);
}

/** Best-effort `milestone_index` extraction from an event's decoded payload. */
function extractMilestoneIndex(dataJson: string): number | undefined {
  try {
    const parsed = JSON.parse(dataJson) as Record<string, unknown> | null;
    const raw = parsed?.milestone_index;
    if (typeof raw === "number" && Number.isInteger(raw)) return raw;
    if (typeof raw === "string" && raw.trim() !== "") {
      const value = Number(raw);
      if (Number.isInteger(value)) return value;
    }
  } catch {
    // Undecodable payloads simply omit the milestone index.
  }
  return undefined;
}

interface EmailJob {
  subscriptionId: number;
  email: string;
  unsubscribeToken: string;
  contractId: string;
  eventId: string;
  type: NotificationEventType;
  milestoneIndex?: number;
}

/** Cap on the in-flight queue; excess jobs are dropped and counted. */
const MAX_SEEN_KEYS = 10000;

let queue: EmailJob[] = [];
let seen = new Set<string>();
let dropped = 0;
let processing: Promise<void> = Promise.resolve();

/** Reset the queue/dedup state (used by tests). */
export function resetEmailDeliveryQueueForTests(): void {
  queue = [];
  seen = new Set<string>();
  dropped = 0;
  processing = Promise.resolve();
}

/** Await every queued email send (used by tests). Never rejects. */
export function flushEmailDeliveryQueueForTests(): Promise<void> {
  return processing;
}

/** Number of jobs dropped because the queue was at capacity (tests/metrics). */
export function getDroppedEmailJobs(): number {
  return dropped;
}

function enqueueJob(job: EmailJob): void {
  const key = `${job.subscriptionId}:${job.eventId}`;
  if (seen.has(key)) return;
  seen.add(key);
  if (seen.size > MAX_SEEN_KEYS) seen = new Set<string>();

  if (queue.length >= config.emailDeliveryQueueMax) {
    dropped += 1;
    if (dropped === 1 || dropped % 100 === 0) {
      logger.warn("Email delivery queue full – dropping notification", {
        dropped,
        queueLength: queue.length,
      });
    }
    return;
  }
  queue.push(job);
}

async function processQueue(): Promise<void> {
  while (queue.length > 0) {
    const job = queue.shift();
    if (!job) continue;
    try {
      const { subject, text, html } = renderNotificationEmail(job.type, {
        contractId: job.contractId,
        milestoneIndex: job.milestoneIndex,
        unsubscribeUrl: buildUnsubscribeUrl(job.unsubscribeToken),
      });
      await sendMail({ to: job.email, subject, text, html });
    } catch (err) {
      // sendMail already swallows transport errors; this guards template /
      // rendering failures so one bad job cannot stop the queue.
      logger.warn("Email notification delivery failed", {
        subscriptionId: job.subscriptionId,
        error: formatError(err),
      });
    }
  }
}

/**
 * Read the events in `[startLedger, endLedger]` for contracts with confirmed
 * email subscriptions, enqueue matching notifications and start draining the
 * queue. Returns a promise that settles when this batch has been processed and
 * never rejects, so the poller can fire-and-forget it.
 */
export async function enqueueEmailNotifications(
  startLedger: number,
  endLedger: number,
  contractIds?: string[],
): Promise<void> {
  if (!isEmailNotificationsEnabled()) return;

  const subscriptions = getConfirmedEmailSubscriptions();
  if (subscriptions.length === 0) return;

  const contractFilter = contractIds ? new Set(contractIds) : null;
  const byContract = new Map<string, EmailSubscription[]>();
  for (const sub of subscriptions) {
    if (contractFilter && !contractFilter.has(sub.contract_id)) continue;
    const list = byContract.get(sub.contract_id) ?? [];
    list.push(sub);
    byContract.set(sub.contract_id, list);
  }
  if (byContract.size === 0) return;

  const db = getDb();
  const scopedContractIds = [...byContract.keys()];
  const placeholders = scopedContractIds.map(() => "?").join(", ");
  const events = db
    .prepare(
      `SELECT * FROM events
       WHERE ledger_sequence >= ? AND ledger_sequence <= ?
         AND contract_id IN (${placeholders})
       ORDER BY ledger_sequence ASC, id ASC`,
    )
    .all(startLedger, endLedger, ...scopedContractIds) as EventDbRow[];

  let enqueued = 0;
  for (const event of events) {
    const type = notificationTypeForEvent(event.event_type);
    if (!type) continue;
    const milestoneIndex = extractMilestoneIndex(event.data_json);
    for (const sub of byContract.get(event.contract_id) ?? []) {
      if (!subscriptionWants(sub, type)) continue;
      enqueueJob({
        subscriptionId: sub.id,
        email: sub.email,
        unsubscribeToken: sub.unsubscribe_token,
        contractId: sub.contract_id,
        eventId: String(event.id),
        type,
        milestoneIndex,
      });
      enqueued += 1;
    }
  }

  if (enqueued > 0) {
    processing = processing.then(
      () => processQueue(),
      () => processQueue(),
    );
  }
  return processing;
}

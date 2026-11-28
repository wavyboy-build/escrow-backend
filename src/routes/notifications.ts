import { Router } from "express";
import type { Request, Response } from "express";
import { config } from "../config.js";
import { sendSuccess, sendError } from "../utils/api-response.js";
import { validate } from "../middleware/validate.js";
import {
  emailSubscribeBodySchema,
  type EmailSubscribeBody,
} from "../schemas/notifications.js";
import {
  confirmEmailSubscription,
  countEmailSubscriptionsForEmail,
  hasEmailSubscription,
  removeEmailSubscriptionByUnsubscribeToken,
  upsertEmailSubscription,
} from "../indexer/db.js";
import { isEmailNotificationsEnabled, sendMail } from "../utils/mail.js";
import {
  buildConfirmUrl,
  buildUnsubscribeUrl,
  renderConfirmationEmail,
} from "../utils/email-templates.js";
import { formatError } from "../utils/format-error.js";
import logger from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Per-contract email notifications (#1044)
// ---------------------------------------------------------------------------
// Unauthenticated endpoints for individual clients/freelancers who cannot use
// the admin-gated /api/webhooks/* routes. Anti-abuse is layered:
//   * per-IP rate limit      -> stops a single caller spamming subscriptions
//   * per-email rate limit    -> stops mail-bombing one recipient
//   * per-email subscription cap -> bounds pending/active rows per address
// and every subscription must be confirmed before any mail is delivered.

const router = Router();

const FEATURE_DISABLED_MESSAGE = "Email notifications are not enabled";
const DISABLED_RESPONSE = { status: 503, error: FEATURE_DISABLED_MESSAGE } as const;

interface RateBucket {
  count: number;
  resetAt: number;
}

const ipBuckets = new Map<string, RateBucket>();
const emailBuckets = new Map<string, RateBucket>();

/** Reset the limiter state (used by tests). */
export function resetEmailRateLimitBuckets(): void {
  ipBuckets.clear();
  emailBuckets.clear();
}

function consumeBucket(
  buckets: Map<string, RateBucket>,
  key: string,
  max: number,
): boolean {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + config.emailRateLimitWindowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  return bucket.count <= max;
}

function clientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

// ---------------------------------------------------------------------------
// POST /api/notifications/email – start a double-opt-in subscription
// ---------------------------------------------------------------------------
router.post(
  "/email",
  validate(emailSubscribeBodySchema, "body", (req) =>
    logger.warn("Invalid email subscription request body", {
      contractId: (req.body as { contract_id?: unknown })?.contract_id,
    }),
  ),
  async (req: Request, res: Response) => {
    if (!isEmailNotificationsEnabled()) {
      sendError(res, DISABLED_RESPONSE.status, DISABLED_RESPONSE.error);
      return;
    }

    const { contract_id: contractId, email, event_types: eventTypes } =
      req.body as EmailSubscribeBody;

    if (!consumeBucket(ipBuckets, clientIp(req), config.emailRateLimitMaxPerIp)) {
      logger.warn("Email subscription rate limit exceeded (ip)", { contractId });
      sendError(res, 429, "Too many subscription requests, please try again later");
      return;
    }
    if (!consumeBucket(emailBuckets, email, config.emailRateLimitMaxPerEmail)) {
      logger.warn("Email subscription rate limit exceeded (email)", { contractId });
      sendError(res, 429, "Too many subscription requests, please try again later");
      return;
    }

    // Cap only applies when this (contract, email) pair is new; refreshing an
    // existing subscription must always be allowed.
    if (
      !hasEmailSubscription(contractId, email) &&
      countEmailSubscriptionsForEmail(email) >= config.emailMaxSubscriptionsPerEmail
    ) {
      logger.warn("Email subscription cap reached", { contractId });
      sendError(res, 429, "Too many active subscriptions for this email address");
      return;
    }

    try {
      const subscription = upsertEmailSubscription(
        contractId,
        email,
        eventTypes ?? ["*"],
      );

      const { subject, text, html } = renderConfirmationEmail({
        contractId,
        confirmUrl: buildConfirmUrl(subscription.confirmation_token),
        unsubscribeUrl: buildUnsubscribeUrl(subscription.unsubscribe_token),
      });
      // Best-effort: a mail outage must not fail the subscription request.
      await sendMail({ to: email, subject, text, html });

      logger.info("Email subscription created (pending confirmation)", {
        contractId,
        subscriptionId: subscription.id,
      });
      sendSuccess(res, {
        message: "Confirmation email sent",
        contract_id: contractId,
      });
    } catch (err) {
      logger.error("Failed to create email subscription", {
        contractId,
        error: formatError(err),
      });
      sendError(res, 500, "Internal server error");
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/notifications/email/confirm?token=... – complete the opt-in
// ---------------------------------------------------------------------------
router.get("/email/confirm", (req: Request, res: Response) => {
  if (!isEmailNotificationsEnabled()) {
    sendError(res, DISABLED_RESPONSE.status, DISABLED_RESPONSE.error);
    return;
  }
  const token = typeof req.query.token === "string" ? req.query.token : "";
  if (token.trim() === "") {
    sendError(res, 400, "token is required");
    return;
  }

  const subscription = confirmEmailSubscription(token);
  if (!subscription) {
    sendError(res, 400, "Invalid or expired confirmation token");
    return;
  }

  logger.info("Email subscription confirmed", {
    contractId: subscription.contract_id,
    subscriptionId: subscription.id,
  });
  sendSuccess(res, { message: "Subscription confirmed", contract_id: subscription.contract_id });
});

// ---------------------------------------------------------------------------
// GET /unsubscribe?token=... – one-click unsubscribe (mounted at the root)
// ---------------------------------------------------------------------------
export const unsubscribeRouter = Router();

unsubscribeRouter.get("/unsubscribe", (req: Request, res: Response) => {
  if (!isEmailNotificationsEnabled()) {
    sendError(res, DISABLED_RESPONSE.status, DISABLED_RESPONSE.error);
    return;
  }
  const token = typeof req.query.token === "string" ? req.query.token : "";
  if (token.trim() === "") {
    sendError(res, 400, "token is required");
    return;
  }

  const removed = removeEmailSubscriptionByUnsubscribeToken(token);
  if (!removed) {
    sendError(res, 404, "Subscription not found");
    return;
  }

  logger.info("Email subscription removed via one-click unsubscribe");
  sendSuccess(res, { message: "Unsubscribed successfully" });
});

export default router;

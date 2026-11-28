import { z } from "zod";
import { isValidStellarContractId } from "../utils/stellar.js";

/**
 * Milestone-lifecycle notification types a per-contract email subscriber can
 * opt into (#1044). These are the public, human-readable labels echoed back in
 * confirmation/unsubscribe emails and matched against the indexed events.
 */
export const NOTIFICATION_EVENT_TYPES = [
  "delivered",
  "approved",
  "disputed",
  "auto_release_available",
] as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

/**
 * Body for `POST /api/notifications/email`. `event_types` is optional and
 * defaults to every lifecycle type; an empty array is rejected so a
 * subscription always means "notify me about something".
 */
export const emailSubscribeBodySchema = z
  .object({
    contract_id: z
      .string()
      .refine(isValidStellarContractId, {
        message: "contract_id must be a valid Stellar contract ID (C...)",
      }),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .email({ message: "email must be a valid email address" }),
    event_types: z
      .array(z.enum(NOTIFICATION_EVENT_TYPES))
      .nonempty({ message: "event_types must not be empty when provided" })
      .optional(),
  })
  .strict();

export type EmailSubscribeBody = z.infer<typeof emailSubscribeBodySchema>;

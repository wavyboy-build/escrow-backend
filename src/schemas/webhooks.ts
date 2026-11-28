import { z } from "zod";
import { isValidStellarAddress } from "../utils/stellar.js";

/**
 * Granular webhook subscription filters (#1041).
 *
 * Subscribers can narrow delivery beyond `event_types`: an event only matches
 * when its decoded payload satisfies every configured key. Each key is
 * optional; an absent key means "no constraint on this dimension", so a
 * subscription without `filters` behaves exactly as before.
 *
 * - `milestone_index`: deliver only events whose decoded `milestone_index` is
 *   one of the listed values.
 * - `party`: deliver only events whose decoded `client`, `freelancer`,
 *   `arbiter` or `caller` equals the configured Stellar account (G...) address.
 */
export const webhookFiltersSchema = z
  .object({
    milestone_index: z
      .array(z.number().int().nonnegative())
      .nonempty()
      .optional(),
    party: z
      .string()
      .refine(isValidStellarAddress, {
        message: "party must be a valid Stellar account address (G...)",
      })
      .optional(),
  })
  .strict();

export type WebhookFilters = z.infer<typeof webhookFiltersSchema>;

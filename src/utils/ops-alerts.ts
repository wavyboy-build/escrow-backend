import { config } from "../config.js";
import logger from "./logger.js";

// ---------------------------------------------------------------------------
// Operator alerting (#1042)
// ---------------------------------------------------------------------------
// Critical operational failures (poller failure/stall, reconciliation mismatch,
// webhook auto-disable, skipped ledger ranges, network mismatch at startup)
// previously only reached stdout/stderr, where nobody notices them overnight.
//
// `sendOpsAlert` posts a compact JSON payload to an operator-configured
// incoming webhook (read OPS_ALERT_WEBHOOK_URL). It is deliberately fail-open:
// with the URL unset it is a silent no-op, the payload carries both the Slack
// (`text`) and Discord (`content`) fields, identical alerts are deduplicated by
// title, delivery is bounded by a 5s timeout and every error is swallowed so
// alerting can never throw into the code path it is reporting on.
//
// Unlike subscriber webhook URLs this target is operator-controlled, so the
// subscriber SSRF guard is intentionally NOT applied; only the `https:` scheme
// is enforced.

export type OpsAlertSeverity = "info" | "warning" | "critical";

export interface OpsAlert {
  severity: OpsAlertSeverity;
  title: string;
  details?: Record<string, unknown> | string;
}

/** Injected by tests; receives the resolved URL and the alert. */
export type OpsAlertTransport = (url: string, alert: OpsAlert) => void | Promise<void>;

/** Hard upper bound on a single alert delivery attempt. */
export const OPS_ALERT_TIMEOUT_MS = 5000;

let transportOverride: OpsAlertTransport | null = null;
const lastSentAtByTitle = new Map<string, number>();

/** Test hook: inject a transport, or `null` to restore the real fetch transport. */
export function setOpsAlertTransport(transport: OpsAlertTransport | null): void {
  transportOverride = transport;
}

/** Test hook: clear the dedup window and any injected transport. */
export function resetOpsAlertState(): void {
  lastSentAtByTitle.clear();
  transportOverride = null;
}

function formatDetails(details: OpsAlert["details"]): string {
  if (details === undefined) return "";
  if (typeof details === "string") return details;
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

/**
 * Build a payload readable by both Slack (`text`) and Discord (`content`)
 * incoming webhooks; each ignores the field it does not use.
 */
export function buildOpsAlertPayload(alert: OpsAlert): { text: string; content: string } {
  const lines = [`[${alert.severity.toUpperCase()}] ${alert.title}`];
  const details = formatDetails(alert.details);
  if (details) lines.push(details);
  const text = lines.join("\n");
  return { text, content: text };
}

/**
 * Resolve the configured alert URL. Returns `null` (caller stays a no-op) when
 * unset, unparseable, or not `https:`.
 */
function resolveAlertUrl(): string | null {
  const raw = config.opsAlertWebhookUrl;
  if (!raw) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    logger.warn("OPS_ALERT_WEBHOOK_URL is not a valid URL – ops alerts disabled");
    return null;
  }
  if (parsed.protocol !== "https:") {
    logger.warn("OPS_ALERT_WEBHOOK_URL must use https: – ops alerts disabled", {
      protocol: parsed.protocol,
    });
    return null;
  }
  return parsed.toString();
}

async function deliverOpsAlert(url: string, alert: OpsAlert): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPS_ALERT_TIMEOUT_MS);
  timer.unref?.();
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildOpsAlertPayload(alert)),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fire an operator alert. Never throws and never blocks the caller: delivery
 * happens in the background and failures are logged at `warn`.
 */
export function sendOpsAlert(alert: OpsAlert): void {
  try {
    const url = resolveAlertUrl();
    if (!url) return;

    const now = Date.now();
    const minIntervalMs = config.opsAlertMinIntervalS * 1000;
    const lastSentAt = lastSentAtByTitle.get(alert.title);
    if (lastSentAt !== undefined && now - lastSentAt < minIntervalMs) {
      logger.debug("Ops alert suppressed by dedup window", {
        title: alert.title,
        severity: alert.severity,
      });
      return;
    }
    lastSentAtByTitle.set(alert.title, now);

    const transport = transportOverride ?? deliverOpsAlert;
    void Promise.resolve(transport(url, alert)).catch((err) => {
      logger.warn("Ops alert delivery failed", {
        title: alert.title,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  } catch (err) {
    // Alerting must never change the behaviour of the code being reported on.
    logger.debug("Ops alert dispatch skipped", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

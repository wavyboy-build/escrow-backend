import type { Transporter } from "nodemailer";
import { config } from "../config.js";
import logger from "./logger.js";

// ---------------------------------------------------------------------------
// Mail transport (#1044)
// ---------------------------------------------------------------------------
// The email-notification feature is gated on SMTP_URL: when it is unset there
// is no transport, `isEmailNotificationsEnabled()` is false, and every send is
// skipped. Tests inject a fake transport with `setMailTransport` so no real
// SMTP connection is ever opened (mirrors ops-alerts).
//
// `sendMail` never throws: a mail failure must not break the indexing pipeline
// or the HTTP request that triggered it.

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface MailTransport {
  send(message: MailMessage): Promise<void>;
}

/** True when the feature is enabled (SMTP_URL configured). */
export function isEmailNotificationsEnabled(): boolean {
  return config.smtpUrl.length > 0;
}

let injectedTransport: MailTransport | null = null;

/** Inject a transport (tests); pass null to clear the override. */
export function setMailTransport(transport: MailTransport | null): void {
  injectedTransport = transport;
}

/**
 * Lazy SMTP transport backed by nodemailer. `nodemailer` is imported on the
 * first send so the (heavy) module is never loaded when the feature is off.
 */
function createSmtpTransport(): MailTransport {
  let transporterPromise: Promise<Transporter> | null = null;

  function getTransporter(): Promise<Transporter> {
    if (!transporterPromise) {
      transporterPromise = import("nodemailer").then((mod) => {
        const nodemailer = (mod as { default?: unknown }).default ?? mod;
        const createTransport = (nodemailer as {
          createTransport: (url: string) => Transporter;
        }).createTransport;
        return createTransport(config.smtpUrl);
      });
    }
    return transporterPromise;
  }

  return {
    async send(message: MailMessage): Promise<void> {
      const transporter = await getTransporter();
      await transporter.sendMail({
        from: config.emailFrom,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    },
  };
}

/** The active transport: the injected one, else the SMTP transport, else null. */
export function getMailTransport(): MailTransport | null {
  if (injectedTransport) return injectedTransport;
  if (!isEmailNotificationsEnabled()) return null;
  return createSmtpTransport();
}

/**
 * Send one message. Returns true on success and false on any failure (or when
 * the feature is disabled); it never throws into the caller.
 */
export async function sendMail(message: MailMessage): Promise<boolean> {
  const transport = getMailTransport();
  if (!transport) return false;

  try {
    await transport.send(message);
    return true;
  } catch (err) {
    logger.warn("Failed to send email notification", {
      to: message.to,
      subject: message.subject,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

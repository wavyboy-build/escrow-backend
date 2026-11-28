import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import request from "supertest";
import express from "express";
import {
  initSchema,
  setDb,
  insertEvent,
  upsertEmailSubscription,
  getEmailSubscriptionByConfirmationToken,
  getConfirmedEmailSubscriptionsForContract,
} from "../src/indexer/db.js";
import {
  setMailTransport,
  sendMail,
  isEmailNotificationsEnabled,
  type MailMessage,
} from "../src/utils/mail.js";
import {
  enqueueEmailNotifications,
  resetEmailDeliveryQueueForTests,
  flushEmailDeliveryQueueForTests,
  notificationTypeForEvent,
} from "../src/indexer/email-delivery.js";

// ---------------------------------------------------------------------------
// Per-contract email notifications (#1044)
// ---------------------------------------------------------------------------
// The whole suite runs against an in-memory DB and an injected fake mail
// transport, so no real SMTP connection is ever opened.

const CONTRACT_A = "CARZQMYKDGA4TTIE2XBDJ42EX27VYLLJGGG4WGUIXXWIVHPDTX3UCLJA";
const CONTRACT_B = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";

let testDb: Database.Database;
let app: express.Express;
let resetEmailRateLimitBuckets: () => void;

const sent: MailMessage[] = [];
const fakeTransport = {
  send: jest.fn(async (message: MailMessage): Promise<void> => {
    sent.push(message);
  }),
};

/** Pull `token=...` out of a rendered email body (text or html). */
function extractToken(body: string, base: string): string {
  const match = body.match(new RegExp(`${base}\\?token=([a-f0-9]+)`));
  if (!match) throw new Error(`no ${base} token in email body`);
  return match[1];
}

const originalSmtpUrl = process.env.SMTP_URL;
const originalRateIp = process.env.EMAIL_RATE_LIMIT_MAX_PER_IP;
const originalRateEmail = process.env.EMAIL_RATE_LIMIT_MAX_PER_EMAIL;
const originalCap = process.env.EMAIL_MAX_SUBSCRIPTIONS_PER_EMAIL;

beforeAll(async () => {
  testDb = new Database(":memory:");
  setDb(testDb);
  initSchema();

  const mod = await import("../src/routes/notifications.js");
  resetEmailRateLimitBuckets = mod.resetEmailRateLimitBuckets;

  app = express();
  app.use(express.json());
  app.use("/api/notifications", mod.default);
  app.use(mod.unsubscribeRouter);
});

afterAll(() => {
  testDb.close();
  setMailTransport(null);
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore("SMTP_URL", originalSmtpUrl);
  restore("EMAIL_RATE_LIMIT_MAX_PER_IP", originalRateIp);
  restore("EMAIL_RATE_LIMIT_MAX_PER_EMAIL", originalRateEmail);
  restore("EMAIL_MAX_SUBSCRIPTIONS_PER_EMAIL", originalCap);
});

beforeEach(() => {
  testDb.exec("DELETE FROM email_subscriptions");
  testDb.exec("DELETE FROM events");
  sent.length = 0;
  fakeTransport.send.mockClear();
  setMailTransport(fakeTransport);
  // Feature ON by default for every test; individual tests override.
  process.env.SMTP_URL = "smtps://user:pass@smtp.example.com:465";
  delete process.env.EMAIL_RATE_LIMIT_MAX_PER_IP;
  delete process.env.EMAIL_RATE_LIMIT_MAX_PER_EMAIL;
  delete process.env.EMAIL_MAX_SUBSCRIPTIONS_PER_EMAIL;
  resetEmailRateLimitBuckets();
  resetEmailDeliveryQueueForTests();
});

describe("mail transport (#1044)", () => {
  it("reports the feature disabled when SMTP_URL is unset", () => {
    process.env.SMTP_URL = "";
    expect(isEmailNotificationsEnabled()).toBe(false);
  });

  it("never throws when the transport fails", async () => {
    setMailTransport({
      send: async () => {
        throw new Error("smtp down");
      },
    });
    await expect(
      sendMail({ to: "a@b.com", subject: "s", text: "t", html: "<p>t</p>" }),
    ).resolves.toBe(false);
  });

  it("returns false (no transport) when the feature is disabled", async () => {
    process.env.SMTP_URL = "";
    setMailTransport(null);
    await expect(
      sendMail({ to: "a@b.com", subject: "s", text: "t", html: "<p>t</p>" }),
    ).resolves.toBe(false);
  });
});

describe("POST /api/notifications/email – double opt-in (#1044)", () => {
  const body = {
    contract_id: CONTRACT_A,
    email: "Client@Example.com",
    event_types: ["delivered", "approved"],
  };

  it("stores a pending row and dispatches a confirmation email", async () => {
    const res = await request(app)
      .post("/api/notifications/email")
      .send(body)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.contract_id).toBe(CONTRACT_A);

    // Exactly one confirmation email, addressed to the normalised address.
    expect(fakeTransport.send).toHaveBeenCalledTimes(1);
    expect(sent[0].to).toBe("client@example.com");

    // The row exists but is not yet confirmed.
    const token = extractToken(sent[0].text, "confirm");
    const row = getEmailSubscriptionByConfirmationToken(token);
    expect(row?.confirmed).toBe(0);
    expect(row?.email).toBe("client@example.com");
    expect(row?.event_types).toBe(JSON.stringify(["delivered", "approved"]));
    // The confirmation email also offers an immediate opt-out link.
    expect(sent[0].text).toContain("/unsubscribe?token=");
  });

  it("suppresses notifications until the subscription is confirmed", async () => {
    await request(app).post("/api/notifications/email").send(body).expect(200);
    sent.length = 0;
    fakeTransport.send.mockClear();

    insertEvent(CONTRACT_A, "deliver", 500, 1700000000, JSON.stringify({ milestone_index: 0 }));
    await enqueueEmailNotifications(500, 500);

    expect(fakeTransport.send).not.toHaveBeenCalled();
  });

  it("activates the subscription via the confirmation link", async () => {
    await request(app).post("/api/notifications/email").send(body).expect(200);
    const token = extractToken(sent[0].text, "confirm");

    const res = await request(app)
      .get("/api/notifications/email/confirm")
      .query({ token })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.contract_id).toBe(CONTRACT_A);

    const [row] = getConfirmedEmailSubscriptionsForContract(CONTRACT_A);
    expect(row.email).toBe("client@example.com");
  });

  it("rejects an unknown confirmation token with 400", async () => {
    const res = await request(app)
      .get("/api/notifications/email/confirm")
      .query({ token: "deadbeef" })
      .expect(400);
    expect(res.body.success).toBe(false);
  });

  it("rejects invalid payloads with 400", async () => {
    await request(app)
      .post("/api/notifications/email")
      .send({ contract_id: "not-a-contract", email: "x@y.com" })
      .expect(400);
    await request(app)
      .post("/api/notifications/email")
      .send({ contract_id: CONTRACT_A, email: "not-an-email" })
      .expect(400);
    await request(app)
      .post("/api/notifications/email")
      .send({ contract_id: CONTRACT_A, email: "x@y.com", event_types: [] })
      .expect(400);
    expect(getConfirmedEmailSubscriptionsForContract(CONTRACT_A)).toHaveLength(0);
  });
});

describe("rate limits & caps (#1044)", () => {
  it("enforces the per-email rate limit", async () => {
    process.env.EMAIL_RATE_LIMIT_MAX_PER_EMAIL = "1";
    await request(app)
      .post("/api/notifications/email")
      .send({ contract_id: CONTRACT_A, email: "dup@example.com" })
      .expect(200);
    const res = await request(app)
      .post("/api/notifications/email")
      .send({ contract_id: CONTRACT_A, email: "dup@example.com" })
      .expect(429);
    expect(res.body.success).toBe(false);
  });

  it("enforces the per-IP rate limit", async () => {
    process.env.EMAIL_RATE_LIMIT_MAX_PER_IP = "1";
    await request(app)
      .post("/api/notifications/email")
      .send({ contract_id: CONTRACT_A, email: "first@example.com" })
      .expect(200);
    const res = await request(app)
      .post("/api/notifications/email")
      .send({ contract_id: CONTRACT_B, email: "second@example.com" })
      .expect(429);
    expect(res.body.success).toBe(false);
  });

  it("caps the number of subscriptions a single address may hold", async () => {
    process.env.EMAIL_MAX_SUBSCRIPTIONS_PER_EMAIL = "1";
    await request(app)
      .post("/api/notifications/email")
      .send({ contract_id: CONTRACT_A, email: "capped@example.com" })
      .expect(200);
    const res = await request(app)
      .post("/api/notifications/email")
      .send({ contract_id: CONTRACT_B, email: "capped@example.com" })
      .expect(429);
    expect(res.body.success).toBe(false);
  });

  it("still allows refreshing an existing (contract, email) subscription", async () => {
    process.env.EMAIL_MAX_SUBSCRIPTIONS_PER_EMAIL = "1";
    await request(app)
      .post("/api/notifications/email")
      .send({ contract_id: CONTRACT_A, email: "refresh@example.com" })
      .expect(200);
    await request(app)
      .post("/api/notifications/email")
      .send({ contract_id: CONTRACT_A, email: "refresh@example.com" })
      .expect(200);
  });
});

describe("GET /unsubscribe – one-click opt-out (#1044)", () => {
  it("deactivates the subscription for a valid token", async () => {
    await request(app)
      .post("/api/notifications/email")
      .send({ contract_id: CONTRACT_A, email: "bye@example.com" })
      .expect(200);
    const token = extractToken(sent[0].text, "unsubscribe");

    const res = await request(app)
      .get("/unsubscribe")
      .query({ token })
      .expect(200);
    expect(res.body.success).toBe(true);

    await request(app).get("/unsubscribe").query({ token }).expect(404);
    expect(getConfirmedEmailSubscriptionsForContract(CONTRACT_A)).toHaveLength(0);
  });

  it("rejects a missing token with 400", async () => {
    const res = await request(app).get("/unsubscribe").expect(400);
    expect(res.body.success).toBe(false);
  });
});

describe("delivery pipeline (#1044)", () => {
  async function confirmSubscription(contractId: string, email: string, types?: string[]) {
    const sub = upsertEmailSubscription(contractId, email, types ?? ["*"]);
    testDb
      .prepare("UPDATE email_subscriptions SET confirmed = 1 WHERE id = ?")
      .run(sub.id);
    return sub;
  }

  it("delivers a matching event to a confirmed subscriber", async () => {
    await confirmSubscription(CONTRACT_A, "sub@example.com", ["delivered"]);
    insertEvent(CONTRACT_A, "deliver", 700, 1700000000, JSON.stringify({ milestone_index: 3 }));

    await enqueueEmailNotifications(700, 700);
    await flushEmailDeliveryQueueForTests();

    expect(fakeTransport.send).toHaveBeenCalledTimes(1);
    expect(sent[0].to).toBe("sub@example.com");
    expect(sent[0].subject).toContain("Milestone #3");
    // Every notification email carries the one-click unsubscribe link.
    expect(sent[0].html).toContain("/unsubscribe?token=");
    expect(sent[0].text).toContain("/unsubscribe?token=");
  });

  it("ignores subscribers who did not opt into the event type", async () => {
    await confirmSubscription(CONTRACT_A, "only-approved@example.com", ["approved"]);
    insertEvent(CONTRACT_A, "deliver", 701, 1700000001, JSON.stringify({ milestone_index: 0 }));

    await enqueueEmailNotifications(701, 701);
    await flushEmailDeliveryQueueForTests();

    expect(fakeTransport.send).not.toHaveBeenCalled();
  });

  it("scopes delivery to the polled contracts", async () => {
    await confirmSubscription(CONTRACT_A, "a@example.com");
    await confirmSubscription(CONTRACT_B, "b@example.com");
    insertEvent(CONTRACT_A, "approve", 702, 1700000002, JSON.stringify({ milestone_index: 0 }));
    insertEvent(CONTRACT_B, "approve", 702, 1700000002, JSON.stringify({ milestone_index: 0 }));

    await enqueueEmailNotifications(702, 702, [CONTRACT_A]);
    await flushEmailDeliveryQueueForTests();

    expect(fakeTransport.send).toHaveBeenCalledTimes(1);
    expect(sent[0].to).toBe("a@example.com");
  });

  it("is a no-op when the feature is disabled", async () => {
    await confirmSubscription(CONTRACT_A, "off@example.com");
    insertEvent(CONTRACT_A, "approve", 703, 1700000003, JSON.stringify({ milestone_index: 0 }));
    process.env.SMTP_URL = "";

    await enqueueEmailNotifications(703, 703);
    await flushEmailDeliveryQueueForTests();

    expect(fakeTransport.send).not.toHaveBeenCalled();
  });

  it("maps contract discriminators to notification labels", () => {
    expect(notificationTypeForEvent("deliver")).toBe("delivered");
    expect(notificationTypeForEvent("approve")).toBe("approved");
    expect(notificationTypeForEvent("dispute")).toBe("disputed");
    expect(notificationTypeForEvent("claim")).toBe("auto_release_available");
    expect(notificationTypeForEvent("fund")).toBeNull();
  });
});

describe("feature disablement (#1044)", () => {
  beforeEach(() => {
    process.env.SMTP_URL = "";
  });

  it("returns 503 from every notification endpoint", async () => {
    await request(app)
      .post("/api/notifications/email")
      .send({ contract_id: CONTRACT_A, email: "x@y.com" })
      .expect(503);
    await request(app)
      .get("/api/notifications/email/confirm")
      .query({ token: "abc" })
      .expect(503);
    await request(app).get("/unsubscribe").query({ token: "abc" }).expect(503);
    expect(fakeTransport.send).not.toHaveBeenCalled();
  });
});

import { jest } from "@jest/globals";
import Database from "better-sqlite3";

const mockSendOpsAlert = jest.fn();

jest.unstable_mockModule("../src/utils/ops-alerts.js", () => ({
  sendOpsAlert: mockSendOpsAlert,
}));

const {
  addSubscription,
  getSubscriptions,
  initSchema,
  setDb,
} = await import("../src/indexer/db.js");
const { deliverWebhooks } = await import("../src/indexer/webhook-delivery.js");

const CONTRACT_ID = "COPSALERTAUTO00000000000000000000000000000000000000000000001";
const WEBHOOK_URL = "https://example.com/hook";

describe("ops alert when a webhook subscription is auto-disabled (#1042)", () => {
  let testDb: Database.Database;
  const originalFetch = global.fetch;
  const originalDisableAfter = process.env.WEBHOOK_DISABLE_AFTER;

  beforeAll(() => {
    testDb = new Database(":memory:");
    setDb(testDb);
    initSchema();
  });

  afterAll(() => {
    testDb.close();
    global.fetch = originalFetch;
    if (originalDisableAfter === undefined) delete process.env.WEBHOOK_DISABLE_AFTER;
    else process.env.WEBHOOK_DISABLE_AFTER = originalDisableAfter;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    testDb.exec("DELETE FROM webhook_subscriptions");
    testDb.exec("DELETE FROM events");
    process.env.WEBHOOK_DISABLE_AFTER = "1";
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("fires sendOpsAlert once the failure threshold disables the subscription", async () => {
    addSubscription(CONTRACT_ID, WEBHOOK_URL, ["fund"]);
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
    }) as unknown as Response) as unknown as typeof fetch;

    testDb
      .prepare(
        `INSERT INTO events
           (contract_id, event_type, ledger_sequence, timestamp, data_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(CONTRACT_ID, "fund", 3000, 1700000000, "{}");

    const results = await deliverWebhooks(3000, 3000);

    expect(results).toHaveLength(1);
    expect(getSubscriptions()[0].disabled_at).not.toBeNull();
    const titles = mockSendOpsAlert.mock.calls.map(
      ([alert]) => (alert as { title: string }).title,
    );
    expect(titles).toContain("Webhook subscription auto-disabled");
  });
});

import { jest } from "@jest/globals";
import Database from "better-sqlite3";

const mockSendOpsAlert = jest.fn();
const mockGetLatestLedger = jest.fn<() => Promise<{ sequence: number }>>();
const mockGetEvents = jest.fn<(params: any) => Promise<{ events: unknown[] }>>();
const mockDeliverWebhooks = jest.fn<(start: number, end: number) => Promise<unknown[]>>();

jest.unstable_mockModule("../src/utils/ops-alerts.js", () => ({
  sendOpsAlert: mockSendOpsAlert,
}));

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    getLatestLedger = mockGetLatestLedger;
    getEvents = mockGetEvents;
  },
}));

jest.unstable_mockModule("@stellar/stellar-sdk", () => ({
  scValToNative: (value: unknown) => value,
}));

jest.unstable_mockModule("../src/indexer/webhook-delivery.js", () => ({
  pruneWebhookDeliveries: jest.fn(() => ({ delivered: 0, dead: 0 })),
  deliverWebhooks: mockDeliverWebhooks,
}));

const { pollEvents, resetFailureState } = await import("../src/indexer/poller.js");
const { setDb, runMigrations } = await import("../src/indexer/db.js");

const CONTRACT_ID = "CEMAILALERT00000000000000000000000000000000000000000000001";

function alertTitles(): string[] {
  return mockSendOpsAlert.mock.calls.map(
    ([alert]) => (alert as { title: string }).title,
  );
}

describe("ops alerts from the poller (#1042)", () => {
  let testDb: Database.Database;

  beforeAll(() => {
    testDb = new Database(":memory:");
    setDb(testDb);
    runMigrations();
  });

  afterAll(() => {
    testDb.close();
    delete process.env.CONTRACT_ID;
    delete process.env.POLLER_STALL_THRESHOLD_MS;
  });

  beforeEach(() => {
    resetFailureState();
    jest.clearAllMocks();
    mockDeliverWebhooks.mockResolvedValue([]);
    testDb.exec("DELETE FROM events");
    testDb.exec("DELETE FROM monitored_contracts");
    testDb.exec("UPDATE indexer_state SET value = '0' WHERE key = 'last_ledger_sequence'");
    process.env.CONTRACT_ID = CONTRACT_ID;
  });

  it("alerts when the consecutive failure threshold is exceeded", async () => {
    mockGetLatestLedger.mockRejectedValue(new Error("persistent failure"));

    await pollEvents();
    await pollEvents();
    expect(mockSendOpsAlert).not.toHaveBeenCalled();

    await pollEvents();

    expect(alertTitles()).toContain("Poller alert: consecutive failure threshold exceeded");
  });

  it("alerts on stall detection", async () => {
    process.env.POLLER_STALL_THRESHOLD_MS = "1";

    mockGetLatestLedger.mockResolvedValue({ sequence: 100 });
    mockGetEvents.mockResolvedValue({ events: [] });
    await pollEvents();

    // Ensure elapsed exceeds the 1ms threshold before the next poll.
    await new Promise((resolve) => setTimeout(resolve, 5));
    mockSendOpsAlert.mockClear();

    mockGetLatestLedger.mockResolvedValue({ sequence: 101 });
    mockGetEvents.mockResolvedValue({ events: [] });
    await pollEvents();

    expect(alertTitles()).toContain("Poller stall detected");
  });

  it("alerts when a ledger range is skipped outside the RPC retention window", async () => {
    mockGetLatestLedger.mockResolvedValue({ sequence: 33 });
    mockGetEvents.mockImplementation(async (params: any) => {
      if (!params.cursor && params.startLedger < 7) {
        throw new Error("startLedger must be within the ledger range: 7 - 33");
      }
      return { events: [] };
    });

    await pollEvents();

    expect(alertTitles()).toContain("Ledger range skipped outside RPC retention window");
  });
});

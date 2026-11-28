import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import express from "express";

const mockSendOpsAlert = jest.fn();

jest.unstable_mockModule("../src/utils/ops-alerts.js", () => ({
  sendOpsAlert: mockSendOpsAlert,
}));

const { setDb, runMigrations, insertEvent } = await import("../src/indexer/db.js");
const { reconcileContract } = await import("../src/indexer/reconciliation.js");
const { main } = await import("../src/index.js");

const CONTRACT = "COPSALERTRECON00000000000000000000000000000000000000000000001";
const TOKEN = "COPSALERTTOKEN00000000000000000000000000000000000000000000001";

function alertTitles(): string[] {
  return mockSendOpsAlert.mock.calls.map(
    ([alert]) => (alert as { title: string }).title,
  );
}

describe("ops alert on reconciliation mismatch (#1042)", () => {
  let testDb: Database.Database;

  beforeAll(() => {
    testDb = new Database(":memory:");
    setDb(testDb);
    runMigrations();
  });

  afterAll(() => {
    testDb.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    testDb.exec("DELETE FROM events");
    testDb.exec("DELETE FROM monitored_contracts");
    testDb.exec("DELETE FROM reconciliation_results");
    testDb
      .prepare("INSERT INTO monitored_contracts (contract_id, active) VALUES (?, 1)")
      .run(CONTRACT);
    insertEvent(CONTRACT, "fund", 100, 1000, JSON.stringify({ token: TOKEN, total_amount: "1000" }));
    insertEvent(CONTRACT, "approve", 101, 1100, JSON.stringify({ token: TOKEN, amount: "300" }));
  });

  it("fires sendOpsAlert when the on-chain balance does not match", async () => {
    const reader = jest.fn(async () => 999n);

    const result = await reconcileContract(CONTRACT, reader);

    expect(result.status).toBe("mismatch");
    expect(alertTitles()).toContain("Reconciliation mismatch");
  });

  it("stays silent when the balances match", async () => {
    const reader = jest.fn(async () => 700n);

    const result = await reconcileContract(CONTRACT, reader);

    expect(result.status).toBe("match");
    expect(mockSendOpsAlert).not.toHaveBeenCalled();
  });
});

describe("ops alert on startup network mismatch (#1042)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("fires sendOpsAlert and exits when the network check throws", async () => {
    const exit = jest.fn();

    await main({
      createApp: () => express(),
      runMigrations: jest.fn(),
      markIndexerStarted: jest.fn(),
      assertRpcNetworkMatches: async () => {
        throw new Error("network passphrase mismatch");
      },
      startPoller: jest.fn(),
      startReconciliationJob: jest.fn(),
      registerShutdownHandlers: jest.fn(),
      listen: jest.fn(),
      exit,
    });

    expect(exit).toHaveBeenCalledWith(1);
    const alerts = mockSendOpsAlert.mock.calls.map(([alert]) => alert as { title: string });
    expect(alerts.some((a) => a.title === "Startup network check failed")).toBe(true);
  });
});

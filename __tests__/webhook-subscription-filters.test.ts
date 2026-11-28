import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import request from "supertest";
import express from "express";
import {
  addSubscription,
  getSubscriptions,
  initSchema,
  insertEvent,
  registerContract,
  setDb,
} from "../src/indexer/db.js";

let testDb: Database.Database;

const CONTRACT = "CA3D5K7UXYZ123456789012345678901234567890123456789012345678901";
const WEBHOOK_URL = "https://example.com/hook";
const PARTY_A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const PARTY_B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

beforeAll(() => {
  testDb = new Database(":memory:");
  setDb(testDb);
  initSchema();
});

afterAll(() => {
  testDb.close();
});

beforeEach(() => {
  testDb.exec("DELETE FROM webhook_subscriptions");
  testDb.exec("DELETE FROM events");
});

describe("subscriptionsMatchEvent – granular filters (#1041)", () => {
  const importMatch = async () =>
    (await import("../src/indexer/webhook-delivery.js")).subscriptionsMatchEvent;

  it("matches every event of the configured type when no filters are set", async () => {
    const subscriptionsMatchEvent = await importMatch();
    const sub = { event_types: JSON.stringify(["fund"]), filters_json: null };

    expect(
      subscriptionsMatchEvent(sub, { event_type: "fund", data_json: "{}" }),
    ).toBe(true);
    expect(
      subscriptionsMatchEvent(sub, { event_type: "approve", data_json: "{}" }),
    ).toBe(false);
  });

  it("matches only events whose milestone_index is in the filter array", async () => {
    const subscriptionsMatchEvent = await importMatch();
    const sub = {
      event_types: JSON.stringify(["deliver"]),
      filters_json: JSON.stringify({ milestone_index: [0, 2] }),
    };

    expect(
      subscriptionsMatchEvent(sub, {
        event_type: "deliver",
        data_json: JSON.stringify({ milestone_index: 0 }),
      }),
    ).toBe(true);
    expect(
      subscriptionsMatchEvent(sub, {
        event_type: "deliver",
        data_json: JSON.stringify({ milestone_index: 2 }),
      }),
    ).toBe(true);
    expect(
      subscriptionsMatchEvent(sub, {
        event_type: "deliver",
        data_json: JSON.stringify({ milestone_index: 1 }),
      }),
    ).toBe(false);
  });

  it("treats an event lacking the filtered field as a non-match", async () => {
    const subscriptionsMatchEvent = await importMatch();
    const sub = {
      event_types: JSON.stringify(["*"]),
      filters_json: JSON.stringify({ milestone_index: [0] }),
    };

    expect(
      subscriptionsMatchEvent(sub, { event_type: "fund", data_json: "{}" }),
    ).toBe(false);
  });

  it("matches a party filter against any of client/freelancer/arbiter/caller", async () => {
    const subscriptionsMatchEvent = await importMatch();
    const sub = {
      event_types: JSON.stringify(["*"]),
      filters_json: JSON.stringify({ party: PARTY_A }),
    };

    for (const role of ["client", "freelancer", "arbiter", "caller"]) {
      expect(
        subscriptionsMatchEvent(sub, {
          event_type: "fund",
          data_json: JSON.stringify({ [role]: PARTY_A }),
        }),
      ).toBe(true);
    }
    expect(
      subscriptionsMatchEvent(sub, {
        event_type: "fund",
        data_json: JSON.stringify({ client: PARTY_B }),
      }),
    ).toBe(false);
  });

  it("requires both milestone_index and party when both are configured", async () => {
    const subscriptionsMatchEvent = await importMatch();
    const sub = {
      event_types: JSON.stringify(["approve"]),
      filters_json: JSON.stringify({ milestone_index: [1], party: PARTY_A }),
    };

    expect(
      subscriptionsMatchEvent(sub, {
        event_type: "approve",
        data_json: JSON.stringify({ milestone_index: 1, freelancer: PARTY_A }),
      }),
    ).toBe(true);
    expect(
      subscriptionsMatchEvent(sub, {
        event_type: "approve",
        data_json: JSON.stringify({ milestone_index: 1, freelancer: PARTY_B }),
      }),
    ).toBe(false);
    expect(
      subscriptionsMatchEvent(sub, {
        event_type: "approve",
        data_json: JSON.stringify({ milestone_index: 0, freelancer: PARTY_A }),
      }),
    ).toBe(false);
  });
});

describe("addSubscription persists filters (#1041)", () => {
  it("stores filters_json as JSON and returns it", () => {
    const sub = addSubscription(CONTRACT, WEBHOOK_URL, ["fund"], {
      milestone_index: [0, 1],
    });
    expect(sub.filters_json).toBe(JSON.stringify({ milestone_index: [0, 1] }));
  });

  it("stores null when no filters are supplied", () => {
    const sub = addSubscription(CONTRACT, WEBHOOK_URL, ["fund"]);
    expect(sub.filters_json).toBeNull();
  });

  it("refreshes the stored filters on re-subscribe", () => {
    addSubscription(CONTRACT, WEBHOOK_URL, ["fund"], { milestone_index: [0] });
    const resubscribed = addSubscription(CONTRACT, WEBHOOK_URL, ["fund"], {
      party: PARTY_A,
    });
    expect(resubscribed.filters_json).toBe(JSON.stringify({ party: PARTY_A }));
  });
});

describe("deliverWebhooks honours filters (#1041)", () => {
  const originalFetch = global.fetch;
  let mockFetch: jest.Mock;

  beforeEach(() => {
    mockFetch = jest.fn(async () => ({ ok: true, status: 200 }) as unknown as Response);
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("delivers only the events matching the milestone_index filter", async () => {
    const { deliverWebhooks } = await import("../src/indexer/webhook-delivery.js");

    addSubscription(CONTRACT, WEBHOOK_URL, ["deliver"], { milestone_index: [1] });
    insertEvent(CONTRACT, "deliver", 100, 1000, JSON.stringify({ milestone_index: 0 }));
    insertEvent(CONTRACT, "deliver", 101, 1001, JSON.stringify({ milestone_index: 1 }));

    const results = await deliverWebhooks(100, 101);

    expect(results).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.data.milestone_index).toBe(1);
  });

  it("delivers only events where a party field matches", async () => {
    const { deliverWebhooks } = await import("../src/indexer/webhook-delivery.js");

    addSubscription(CONTRACT, WEBHOOK_URL, ["*"], { party: PARTY_A });
    insertEvent(CONTRACT, "fund", 100, 1000, JSON.stringify({ client: PARTY_B }));
    insertEvent(CONTRACT, "fund", 101, 1001, JSON.stringify({ freelancer: PARTY_A }));

    const results = await deliverWebhooks(100, 101);

    expect(results).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.data.freelancer).toBe(PARTY_A);
  });

  it("behaves as before for a subscription without filters", async () => {
    const { deliverWebhooks } = await import("../src/indexer/webhook-delivery.js");

    addSubscription(CONTRACT, WEBHOOK_URL, ["fund"]);
    insertEvent(CONTRACT, "fund", 100, 1000, JSON.stringify({ milestone_index: 5 }));

    const results = await deliverWebhooks(100, 100);

    expect(results).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("webhook subscribe/subscriptions routes with filters (#1041)", () => {
  let app: express.Express;
  const ADMIN_KEY = "filters-test-admin-key";
  const API_KEY = "filters-test-client-key";
  // A real StrKey contract id: dispatchSubscribe validates the contract id.
  const VALID_CONTRACT = "CARZQMYKDGA4TTIE2XBDJ42EX27VYLLJGGG4WGUIXXWIVHPDTX3UCLJA";
  const originalAdminKey = process.env.ADMIN_API_KEY;
  const originalApiKey = process.env.API_KEY;

  beforeAll(async () => {
    const { default: router } = await import("../src/routes/webhooks.js");
    app = express();
    app.use(express.json());
    app.use("/api/webhooks", router);
  });

  beforeEach(() => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    process.env.API_KEY = API_KEY;
    registerContract(VALID_CONTRACT, "test");
  });

  afterEach(() => {
    if (originalAdminKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = originalAdminKey;
    if (originalApiKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = originalApiKey;
  });

  it("accepts and persists a validated filters object", async () => {
    const res = await request(app)
      .post("/api/webhooks/subscribe")
      .set("x-api-key", ADMIN_KEY)
      .send({
        contract_id: VALID_CONTRACT,
        webhook_url: WEBHOOK_URL,
        event_types: ["fund"],
        filters: { milestone_index: [0, 2] },
      })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.subscription.filters_json).toBe(
      JSON.stringify({ milestone_index: [0, 2] }),
    );
    expect(getSubscriptions()[0].filters_json).toBe(
      JSON.stringify({ milestone_index: [0, 2] }),
    );
  });

  it("rejects an invalid party filter with 400", async () => {
    const res = await request(app)
      .post("/api/webhooks/subscribe")
      .set("x-api-key", ADMIN_KEY)
      .send({
        contract_id: VALID_CONTRACT,
        webhook_url: WEBHOOK_URL,
        filters: { party: "not-an-address" },
      })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(getSubscriptions()).toHaveLength(0);
  });

  it("rejects unknown filter keys with 400", async () => {
    const res = await request(app)
      .post("/api/webhooks/subscribe")
      .set("x-api-key", ADMIN_KEY)
      .send({
        contract_id: VALID_CONTRACT,
        webhook_url: WEBHOOK_URL,
        filters: { milestone_index: [0], unexpected: true },
      })
      .expect(400);

    expect(res.body.success).toBe(false);
  });

  it("echoes the parsed filters from GET /subscriptions", async () => {
    addSubscription(VALID_CONTRACT, WEBHOOK_URL, ["fund"], { milestone_index: [1] });

    const res = await request(app)
      .get("/api/webhooks/subscriptions")
      .query({ contract_id: VALID_CONTRACT })
      .set("x-api-key", API_KEY)
      .expect(200);

    expect(res.body.data.subscriptions[0].filters).toEqual({ milestone_index: [1] });
  });

  it("returns null filters for a subscription without filters", async () => {
    addSubscription(VALID_CONTRACT, WEBHOOK_URL, ["fund"]);

    const res = await request(app)
      .get("/api/webhooks/subscriptions")
      .query({ contract_id: VALID_CONTRACT })
      .set("x-api-key", API_KEY)
      .expect(200);

    expect(res.body.data.subscriptions[0].filters).toBeNull();
  });
});

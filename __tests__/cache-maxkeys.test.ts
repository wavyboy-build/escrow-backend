import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import NodeCache from "node-cache";

// ---------------------------------------------------------------------------
// Bounded caches + hashed submit keys (#1043)
// ---------------------------------------------------------------------------
// Covers:
//   1. `safeCacheSet` tolerates a cache at its `maxKeys` bound (skips the write
//      and logs at debug) and rethrows every other error.
//   2. `submitCacheKey` hashes the signed XDR to a fixed-length digest so the
//      cache never stores 1–2 kB XDR strings as keys.
//   3. `POST /api/jobs/submit` still deduplicates identical submissions now
//      that the cache is keyed by the transaction hash.
// ---------------------------------------------------------------------------

// Rate limiters must all be stubbed: an ESM module mock replaces the whole
// module, so any omitted export breaks the import of the jobs router.
jest.unstable_mockModule("../src/middleware/rateLimiter.js", () => ({
  strictLimiter: (_req: any, _res: any, next: any) => next(),
  walletLookupLimiter: (_req: any, _res: any, next: any) => next(),
  generalLimiter: (_req: any, _res: any, next: any) => next(),
}));

jest.unstable_mockModule("../src/middleware/job-contract-rate-limit.js", () => ({
  submitRateLimit: (_req: any, _res: any, next: any) => next(),
  jobContractRateLimit: (_req: any, _res: any, next: any) => next(),
  partialReleaseRateLimit: (_req: any, _res: any, next: any) => next(),
  jobWhitelistRateLimit: (_req: any, _res: any, next: any) => next(),
  whitelistUpdateRateLimit: (_req: any, _res: any, next: any) => next(),
  buildTxRateLimit: (_req: any, _res: any, next: any) => next(),
  timeRemainingRateLimit: (_req: any, _res: any, next: any) => next(),
  createJobDraftRateLimit: (_req: any, _res: any, next: any) => next(),
  claimAutoReleaseRateLimit: (_req: any, _res: any, next: any) => next(),
  resetSubmitRateLimitBuckets: () => {},
  resetWhitelistUpdateRateLimitBuckets: () => {},
}));

const mockSendTransaction = jest.fn<() => Promise<unknown>>();
const mockTx = { toXDR: () => "mock-xdr" };

jest.unstable_mockModule("@stellar/stellar-sdk/rpc", () => ({
  Server: class MockServer {
    sendTransaction = mockSendTransaction;
  },
}));

jest.unstable_mockModule("@stellar/stellar-sdk", () => ({
  Keypair: {
    random: jest.fn(() => ({
      publicKey: () => "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    })),
  },
  Account: class {},
  TransactionBuilder: { fromXDR: jest.fn(() => mockTx) },
  Contract: jest.fn(),
  Networks: {
    TESTNET: "Test SDF Network ; September 2015",
    PUBLIC: "Public Global Stellar Network ; September 2015",
  },
  BASE_FEE: "100",
  nativeToScVal: jest.fn(),
  scValToNative: jest.fn((val: unknown) => val),
  Address: { fromString: jest.fn(() => ({ toScVal: jest.fn() })) },
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) },
}));

const { safeCacheSet } = await import("../src/utils/cache.js");
const { submitCacheKey } = await import("../src/routes/jobs/caches.js");
const { default: logger } = await import("../src/utils/logger.js");
const { default: router, resetSubmitCache } = await import("../src/routes/jobs.js");

// ---------------------------------------------------------------------------
// safeCacheSet – graceful maxKeys handling
// ---------------------------------------------------------------------------

describe("safeCacheSet – bounded caches (#1043)", () => {
  let debugSpy: jest.SpiedFunction<typeof logger.debug>;
  let warnSpy: jest.SpiedFunction<typeof logger.warn>;
  let errorSpy: jest.SpiedFunction<typeof logger.error>;

  beforeEach(() => {
    debugSpy = jest.spyOn(logger, "debug").mockImplementation(() => undefined);
    warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
    errorSpy = jest.spyOn(logger, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("stores values normally while the cache has room", () => {
    const cache = new NodeCache({ maxKeys: 2, checkperiod: 0 });

    safeCacheSet(cache, "a", 1);
    safeCacheSet(cache, "b", 2);

    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBe(2);
    expect(cache.keys()).toHaveLength(2);
  });

  it("skips the write without throwing once the cache is at maxKeys", () => {
    const cache = new NodeCache({ maxKeys: 2, checkperiod: 0 });

    safeCacheSet(cache, "a", 1);
    safeCacheSet(cache, "b", 2);

    // A third distinct key exceeds the bound: node-cache raises ECACHEFULL.
    expect(() => safeCacheSet(cache, "c", 3)).not.toThrow();

    expect(cache.get("c")).toBeUndefined();
    expect(cache.keys()).toHaveLength(2);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBe(2);
  });

  it("logs the skipped entry at debug level with the offending key", () => {
    const cache = new NodeCache({ maxKeys: 1, checkperiod: 0 });
    safeCacheSet(cache, "first", "value");

    safeCacheSet(cache, "overflow", "value");

    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining("maxKeys capacity"),
      expect.objectContaining({ key: "overflow" }),
    );
  });

  it("does not log at warn/error level when the cache is full", () => {
    const cache = new NodeCache({ maxKeys: 1, checkperiod: 0 });
    safeCacheSet(cache, "first", "value");

    safeCacheSet(cache, "overflow", "value");

    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("honours an explicit TTL when the cache has room", () => {
    const cache = new NodeCache({ checkperiod: 0 });

    safeCacheSet(cache, "k", "v", 60);

    expect(cache.getTtl("k")).toBeGreaterThan(0);
  });

  it("rethrows errors that are not ECACHEFULL", () => {
    const broken = {
      set: () => {
        throw new Error("boom");
      },
    } as unknown as NodeCache;

    expect(() => safeCacheSet(broken, "k", 1)).toThrow("boom");
  });

  it("ECACHEFULL from a real cache carries the errorcode the guard checks", () => {
    const cache = new NodeCache({ maxKeys: 1, checkperiod: 0 });
    cache.set("a", 1);

    let caught: unknown;
    try {
      cache.set("b", 2);
    } catch (err) {
      caught = err;
    }
    expect((caught as { errorcode?: string }).errorcode).toBe("ECACHEFULL");
  });
});

// ---------------------------------------------------------------------------
// submitCacheKey – hash-based key
// ---------------------------------------------------------------------------

const VALID_SIGNED_XDR =
  "AAAAAgAAAABz9B8nR7h4qY6Ran5PlacgCUxOFxOdIQAAAAAAAAAAABAAAAAAAAAAAA==";
const VALID_SIGNED_XDR_2 = VALID_SIGNED_XDR.replace("AAAA", "BBBB");

describe("submitCacheKey – transaction-hash keyed cache (#1043)", () => {
  it("produces a deterministic 64-char hex digest", () => {
    const key = submitCacheKey(VALID_SIGNED_XDR);

    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(submitCacheKey(VALID_SIGNED_XDR)).toBe(key);
  });

  it("collapses identical XDR strings to the same key", () => {
    expect(submitCacheKey(VALID_SIGNED_XDR)).toBe(
      submitCacheKey(`${VALID_SIGNED_XDR}`),
    );
  });

  it("maps different XDR strings to different keys", () => {
    expect(submitCacheKey(VALID_SIGNED_XDR)).not.toBe(
      submitCacheKey(VALID_SIGNED_XDR_2),
    );
  });

  it("never embeds the raw (1–2 kB) XDR in the key", () => {
    const key = submitCacheKey(VALID_SIGNED_XDR);

    expect(key).not.toContain(VALID_SIGNED_XDR);
    expect(key.length).toBe(64);
  });
});

// ---------------------------------------------------------------------------
// POST /api/jobs/submit – dedupe by transaction hash
// ---------------------------------------------------------------------------

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/jobs", router);
  return app;
}

describe("POST /api/jobs/submit – dedupe by transaction hash (#1043)", () => {
  beforeEach(() => {
    mockSendTransaction.mockReset();
    resetSubmitCache();
  });

  it("serves the second identical submission from cache (one network call)", async () => {
    const mockResult = { id: "tx-hash", status: "PENDING", hash: "abc" };
    mockSendTransaction.mockResolvedValue(mockResult);

    const app = buildApp();

    const first = await request(app)
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR })
      .expect(200);
    const second = await request(app)
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR })
      .expect(200);

    expect(first.body).toEqual({ success: true, data: mockResult });
    expect(second.body).toEqual({ success: true, data: mockResult });
    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
  });

  it("treats a different XDR as a distinct cache entry", async () => {
    mockSendTransaction
      .mockResolvedValueOnce({ id: "tx-1", status: "PENDING" })
      .mockResolvedValueOnce({ id: "tx-2", status: "PENDING" });

    const app = buildApp();

    const a = await request(app)
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR })
      .expect(200);
    const b = await request(app)
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR_2 })
      .expect(200);

    expect(a.body.data.id).toBe("tx-1");
    expect(b.body.data.id).toBe("tx-2");
    expect(mockSendTransaction).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed submission so it is retried", async () => {
    mockSendTransaction
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce({ id: "tx-retry", status: "PENDING" });

    const app = buildApp();

    await request(app)
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR })
      .expect(500);

    const retry = await request(app)
      .post("/api/jobs/submit")
      .send({ signedXdr: VALID_SIGNED_XDR })
      .expect(200);

    expect(retry.body.data.id).toBe("tx-retry");
    expect(mockSendTransaction).toHaveBeenCalledTimes(2);
  });
});

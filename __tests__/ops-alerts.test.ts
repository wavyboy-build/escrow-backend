import { jest } from "@jest/globals";
import {
  buildOpsAlertPayload,
  OPS_ALERT_TIMEOUT_MS,
  resetOpsAlertState,
  sendOpsAlert,
  setOpsAlertTransport,
  type OpsAlert,
} from "../src/utils/ops-alerts.js";

const originalFetch = global.fetch;
const ALERT_URL = "https://hooks.example.com/ops";

afterEach(() => {
  resetOpsAlertState();
  global.fetch = originalFetch;
  jest.useRealTimers();
  delete process.env.OPS_ALERT_WEBHOOK_URL;
  delete process.env.OPS_ALERT_MIN_INTERVAL_S;
});

describe("sendOpsAlert (#1042)", () => {
  it("is a silent no-op when OPS_ALERT_WEBHOOK_URL is unset", () => {
    const transport = jest.fn();
    setOpsAlertTransport(transport);

    sendOpsAlert({ severity: "critical", title: "no url" });

    expect(transport).not.toHaveBeenCalled();
  });

  it("refuses a non-https URL and does not deliver", () => {
    process.env.OPS_ALERT_WEBHOOK_URL = "http://hooks.example.com/ops";
    const transport = jest.fn();
    setOpsAlertTransport(transport);

    sendOpsAlert({ severity: "critical", title: "insecure" });

    expect(transport).not.toHaveBeenCalled();
  });

  it("delivers an https URL with a Slack- and Discord-compatible payload", () => {
    process.env.OPS_ALERT_WEBHOOK_URL = ALERT_URL;
    const seen: Array<{ url: string; alert: OpsAlert }> = [];
    setOpsAlertTransport((url, alert) => {
      seen.push({ url, alert });
    });

    sendOpsAlert({
      severity: "warning",
      title: "Reconciliation mismatch",
      details: { contractId: "CABC" },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(ALERT_URL);
    const payload = buildOpsAlertPayload(seen[0].alert);
    expect(payload.text).toContain("Reconciliation mismatch");
    expect(payload.content).toBe(payload.text);
    expect(payload.text).toContain("CABC");
  });

  it("deduplicates identical titles within the interval", () => {
    process.env.OPS_ALERT_WEBHOOK_URL = ALERT_URL;
    const transport = jest.fn();
    setOpsAlertTransport(transport);

    sendOpsAlert({ severity: "critical", title: "dup" });
    sendOpsAlert({ severity: "critical", title: "dup" });

    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("re-sends the same title once the window elapses", () => {
    process.env.OPS_ALERT_WEBHOOK_URL = ALERT_URL;
    process.env.OPS_ALERT_MIN_INTERVAL_S = "900";
    const transport = jest.fn();
    setOpsAlertTransport(transport);

    jest.useFakeTimers();
    jest.setSystemTime(new Date("2020-01-01T00:00:00Z"));
    sendOpsAlert({ severity: "critical", title: "windowed" });
    sendOpsAlert({ severity: "critical", title: "windowed" });
    expect(transport).toHaveBeenCalledTimes(1);

    jest.setSystemTime(new Date("2020-01-01T00:15:00Z"));
    sendOpsAlert({ severity: "critical", title: "windowed" });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("never throws when the transport rejects", async () => {
    process.env.OPS_ALERT_WEBHOOK_URL = ALERT_URL;
    setOpsAlertTransport(() => Promise.reject(new Error("boom")));

    expect(() => sendOpsAlert({ severity: "critical", title: "reject" })).not.toThrow();
    await Promise.resolve();
  });

  it("aborts the delivery after the 5s timeout", async () => {
    process.env.OPS_ALERT_WEBHOOK_URL = ALERT_URL;
    let signal: AbortSignal | undefined;
    const fetchMock = jest.fn((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    jest.useFakeTimers();
    sendOpsAlert({ severity: "critical", title: "slow" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(OPS_ALERT_TIMEOUT_MS);
    expect(signal?.aborted).toBe(true);

    jest.useRealTimers();
    await new Promise((resolve) => setImmediate(resolve));
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { WebhookIngress } from "../webhook-ingress.js";
import type { SCMWebhookEvent } from "../types.js";
import { createHmac } from "node:crypto";

function makeSignature(secret: string, payload: string): string {
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  return `sha256=${sig}`;
}

describe("WebhookIngress", () => {
  let ingress: WebhookIngress;
  const secret = "test-secret-key";

  beforeEach(() => {
    ingress = new WebhookIngress({ port: 3000, secret, dbPath: ":memory:" });
    ingress.initDb();
  });

  describe("verifySignature", () => {
    it("returns true for valid HMAC signature", () => {
      const payload = JSON.stringify({ action: "opened" });
      const sig = makeSignature(secret, payload);
      expect(ingress.verifySignature(payload, sig, secret)).toBe(true);
    });

    it("returns false for invalid HMAC signature", () => {
      const payload = JSON.stringify({ action: "opened" });
      const badSig = "sha256=deadbeefdeadbeefdeadbeefdeadbeef";
      expect(ingress.verifySignature(payload, badSig, secret)).toBe(false);
    });

    it("returns false for empty signature", () => {
      const payload = JSON.stringify({ action: "opened" });
      expect(ingress.verifySignature(payload, "", secret)).toBe(false);
    });
  });

  describe("isDuplicate / recordDelivery", () => {
    it("returns false for new delivery ID", () => {
      expect(ingress.isDuplicate("delivery-abc-123")).toBe(false);
    });

    it("returns true after recording a delivery ID", () => {
      ingress.recordDelivery("delivery-xyz-456", "pull_request");
      expect(ingress.isDuplicate("delivery-xyz-456")).toBe(true);
    });

    it("rejects duplicate delivery IDs", () => {
      ingress.recordDelivery("dup-delivery-789", "push");
      expect(ingress.isDuplicate("dup-delivery-789")).toBe(true);
      // Calling recordDelivery again for same ID should be idempotent (no error)
      expect(() => ingress.recordDelivery("dup-delivery-789", "push")).not.toThrow();
    });
  });

  describe("enqueue / dequeue / getQueueLength", () => {
    function makeEvent(id: string): SCMWebhookEvent {
      return {
        provider: "github",
        kind: "pull_request",
        action: "opened",
        rawEventType: "pull_request",
        deliveryId: id,
        data: {},
      };
    }

    it("FIFO ordering: first enqueued is first dequeued", () => {
      ingress.enqueue(makeEvent("evt-1"));
      ingress.enqueue(makeEvent("evt-2"));
      ingress.enqueue(makeEvent("evt-3"));
      expect(ingress.dequeue()?.deliveryId).toBe("evt-1");
      expect(ingress.dequeue()?.deliveryId).toBe("evt-2");
      expect(ingress.dequeue()?.deliveryId).toBe("evt-3");
    });

    it("dequeue returns null when empty", () => {
      expect(ingress.dequeue()).toBeNull();
    });

    it("getQueueLength tracks correctly", () => {
      expect(ingress.getQueueLength()).toBe(0);
      ingress.enqueue(makeEvent("evt-a"));
      expect(ingress.getQueueLength()).toBe(1);
      ingress.enqueue(makeEvent("evt-b"));
      expect(ingress.getQueueLength()).toBe(2);
      ingress.dequeue();
      expect(ingress.getQueueLength()).toBe(1);
      ingress.dequeue();
      expect(ingress.getQueueLength()).toBe(0);
    });
  });

  describe("initDb", () => {
    it("creates table without error (idempotent)", () => {
      // initDb was called in beforeEach; calling again should be fine
      expect(() => ingress.initDb()).not.toThrow();
    });
  });
});

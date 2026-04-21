import { describe, it, expect, vi, beforeEach } from "vitest";

// Use vi.hoisted so we can reference mock functions inside vi.mock factory
// and also access them in beforeEach for per-test setup.
const mockMessagesCreate = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/sdk", () => ({
  default: function MockAnthropic() {
    return {
      messages: {
        create: mockMessagesCreate,
      },
    };
  },
}));

import { classifyPrType } from "../decomposer.js";

describe("classifyPrType", () => {
  beforeEach(() => {
    // Reset mock to clear queued values, implementations, and call history
    mockMessagesCreate.mockReset();
  });

  it("returns unknown when issue title and body are blank", async () => {
    const result = await classifyPrType("", "");
    expect(result.type).toBe("unknown");
    expect(result.confidence).toBe("low");
    expect(result.reasoning).toBe("blank input");
  });

  it("returns ci-workflow when only title is blank and body is truthy", async () => {
    // "some body".trim() is truthy, so blank check does NOT short-circuit.
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: '{"type":"ci-workflow","confidence":"medium","reasoning":"body only"}' }],
    });
    const result = await classifyPrType("", "some body");
    expect(result.type).toBe("ci-workflow");
  });

  it("returns data-norm when only body is blank and title is truthy", async () => {
    // "some title".trim() is truthy, so blank check does NOT short-circuit.
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: '{"type":"data-norm","confidence":"high","reasoning":"title only"}' }],
    });
    const result = await classifyPrType("some title", "");
    expect(result.type).toBe("data-norm");
  });

  it("returns unknown when model API returns no JSON in response", async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "not json at all" }],
    });
    const result = await classifyPrType("fix bug", "there is a bug");
    expect(result.type).toBe("unknown");
    expect(result.reasoning).toBe("no JSON in model response");
  });

  it("returns unknown when model API throws", async () => {
    mockMessagesCreate.mockRejectedValueOnce(new Error("network error"));
    const result = await classifyPrType("fix bug", "there is a bug");
    expect(result.type).toBe("unknown");
    expect(result.reasoning).toBe("classification request failed");
  });

  it("returns unknown with parsed-from-model reasoning when content array is empty", async () => {
    // res.content = [] -> res.content?.[0]?.type is undefined -> text = "{}" -> JSON parse succeeds with {} -> defaults apply
    mockMessagesCreate.mockResolvedValueOnce({ content: [] });
    const result = await classifyPrType("fix bug", "there is a bug");
    expect(result.type).toBe("unknown");
    expect(result.reasoning).toBe("parsed from model response");
  });

  it("returns unknown with parsed-from-model reasoning when content block is not text", async () => {
    // res.content = [{ type: "tool_use", ... }] -> type !== "text" -> text = "{}" -> JSON parse succeeds with {} -> defaults apply
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{ type: "tool_use", id: "tool-1" }],
    });
    const result = await classifyPrType("fix bug", "there is a bug");
    expect(result.type).toBe("unknown");
    expect(result.reasoning).toBe("parsed from model response");
  });

  it("returns parsed type for valid JSON response", async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: '{"type":"state-bool","confidence":"high","reasoning":"test reasoning"}',
        },
      ],
    });
    const result = await classifyPrType("fix bool", "change int to bool");
    expect(result.type).toBe("state-bool");
    expect(result.confidence).toBe("high");
    expect(result.reasoning).toBe("test reasoning");
  });

  it("returns unknown for unrecognized type field", async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: '{"type":"not-a-real-type","confidence":"high","reasoning":"test"}',
        },
      ],
    });
    const result = await classifyPrType("fix thing", "change something");
    expect(result.type).toBe("unknown");
  });

  it("defaults confidence to low for unrecognized confidence value", async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: '{"type":"ci-workflow","confidence":"very-high","reasoning":"test"}',
        },
      ],
    });
    const result = await classifyPrType("ci fix", "fix CI");
    expect(result.confidence).toBe("low");
  });
});

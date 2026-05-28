import { describe, it, expect } from "vitest";
import { expandEnvVars } from "../config-env-expand.js";

describe("expandEnvVars", () => {
  it("expands ${VAR} in strings", () => {
    process.env["_AO_TEST_VAR"] = "hello";
    const result = expandEnvVars({ key: "${_AO_TEST_VAR}" });
    expect(result).toEqual({ key: "hello" });
    delete process.env["_AO_TEST_VAR"];
  });

  it("expands ${VAR:-default} with fallback when var is unset", () => {
    delete process.env["_AO_TEST_MISSING"];
    const result = expandEnvVars({ key: "${_AO_TEST_MISSING:-fallback}" });
    expect(result).toEqual({ key: "fallback" });
  });

  it("uses env value over fallback when set", () => {
    process.env["_AO_TEST_SET"] = "real";
    const result = expandEnvVars({ key: "${_AO_TEST_SET:-fallback}" });
    expect(result).toEqual({ key: "real" });
    delete process.env["_AO_TEST_SET"];
  });

  it("returns empty string for unset var without fallback", () => {
    delete process.env["_AO_TEST_UNDEF"];
    const result = expandEnvVars({ key: "${_AO_TEST_UNDEF}" });
    expect(result).toEqual({ key: "" });
  });

  it("recurses into nested objects", () => {
    process.env["_AO_TEST_HOST"] = "example.com";
    const result = expandEnvVars({ db: { host: "${_AO_TEST_HOST}" } });
    expect(result).toEqual({ db: { host: "example.com" } });
    delete process.env["_AO_TEST_HOST"];
  });

  it("maps over arrays", () => {
    process.env["_AO_TEST_ITEM"] = "val";
    const result = expandEnvVars({ items: ["${_AO_TEST_ITEM}", "static"] });
    expect(result).toEqual({ items: ["val", "static"] });
    delete process.env["_AO_TEST_ITEM"];
  });

  it("passes through non-string values unchanged", () => {
    const result = expandEnvVars({ num: 42, flag: true, nil: null });
    expect(result).toEqual({ num: 42, flag: true, nil: null });
  });
});

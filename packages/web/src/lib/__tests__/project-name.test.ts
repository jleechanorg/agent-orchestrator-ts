import { describe, expect, it, vi } from "vitest";
import { stringToHue } from "@/lib/project-name";
import Icon from "@/app/icon";
import AppleIcon from "@/app/apple-icon";

// Mock next/og so we can inspect the JSX element passed to ImageResponse
vi.mock("next/og", () => {
  return {
    ImageResponse: class ImageResponse {
      constructor(public element: any, public options?: any) {}
    }
  };
});

// Mock getProjectName to known values in test cases
let mockedProjectName = "ao";
vi.mock("@/lib/project-name", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/project-name")>();
  return {
    ...actual,
    getProjectName: () => mockedProjectName,
  };
});

describe("stringToHue utility", () => {
  it("generates deterministic hue values", () => {
    const input = "test-project-name";
    const hue1 = stringToHue(input);
    const hue2 = stringToHue(input);
    expect(hue1).toBe(hue2);
  });

  it("normalizes hues to the [0, 359] range for various inputs", () => {
    const inputs = ["", "a", "very-long-project-name-with-special-characters-!@#$"];
    for (const input of inputs) {
      const hue = stringToHue(input);
      expect(Number.isInteger(hue)).toBe(true);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThanOrEqual(359);
    }
  });

  it("produces different hues for different strings (sanity check)", () => {
    const hue1 = stringToHue("project-alpha");
    const hue2 = stringToHue("project-beta");
    expect(hue1).not.toBe(hue2);
  });
});

describe("Icon and AppleIcon integration", () => {
  it("renders Icon with style background HSL string containing the correct hue", () => {
    mockedProjectName = "My Awesome Project";
    const expectedHue = stringToHue(mockedProjectName);

    const iconRes = Icon() as any;
    expect(iconRes.element).toBeDefined();
    
    const style = iconRes.element.props.style;
    expect(style.background).toBe(`hsl(${expectedHue}, 60%, 45%)`);
    expect(iconRes.element.props.children).toBe("M"); // "My Awesome Project" -> first letter capitalized
  });

  it("renders AppleIcon with style background HSL string containing the correct hue", () => {
    mockedProjectName = "Zeta Work";
    const expectedHue = stringToHue(mockedProjectName);

    const appleIconRes = AppleIcon() as any;
    expect(appleIconRes.element).toBeDefined();

    const style = appleIconRes.element.props.style;
    expect(style.background).toBe(`hsl(${expectedHue}, 60%, 45%)`);
    expect(appleIconRes.element.props.children).toBe("Z");
  });
});

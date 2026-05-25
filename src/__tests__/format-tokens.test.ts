import { describe, it, expect } from "vitest";
import { formatTokens } from "../adapter.js";

describe("formatTokens", () => {
  it("returns raw integer for n < 1000", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(1)).toBe("1");
    expect(formatTokens(999)).toBe("999");
  });

  it("formats thousands with 1-decimal k", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(12345)).toBe("12.3k");
    expect(formatTokens(999_999)).toBe("1000.0k");
  });

  it("formats millions with 2-decimal M", () => {
    expect(formatTokens(1_000_000)).toBe("1.00M");
    expect(formatTokens(1_500_000)).toBe("1.50M");
    expect(formatTokens(123_456_789)).toBe("123.46M");
  });
});

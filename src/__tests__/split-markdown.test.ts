import { describe, expect, it } from "vitest";
import { splitMarkdownSafe, MARKDOWN_SAFE_LIMIT } from "../utils.js";

describe("splitMarkdownSafe", () => {
  it("returns single chunk when under limit", () => {
    const text = "# Title\n\nSome **bold** text.";
    expect(splitMarkdownSafe(text)).toEqual([text]);
  });

  it("splits at paragraph boundary, all chunks under limit", () => {
    const para = "word ".repeat(100).trim(); // 499 chars
    const text = Array.from({ length: 10 }, (_, i) => `Para ${i}: ${para}`).join("\n\n");
    const chunks = splitMarkdownSafe(text, 2000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000);
    // splits land between paragraphs: every chunk starts at a "Para N:" head
    for (const c of chunks) expect(c.startsWith("Para ")).toBe(true);
    // no content lost
    expect(chunks.join("\n\n")).toBe(text);
  });

  it("closes and reopens a code fence straddling the cut, preserving language", () => {
    const codeLines = Array.from({ length: 200 }, (_, i) => `line_${i} = compute(${i})`).join("\n");
    const text = `Intro paragraph.\n\n\`\`\`python\n${codeLines}\n\`\`\`\n\nOutro.`;
    const chunks = splitMarkdownSafe(text, 1500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(1500);
      // every chunk must have balanced fences (even count of ``` lines)
      const fences = c.split("\n").filter(l => l.trimEnd().match(/^\s{0,3}```/)).length;
      expect(fences % 2).toBe(0);
    }
    // continuation chunks reopen with the language tag
    const reopened = chunks.slice(1).filter(c => c.includes("```python"));
    expect(reopened.length).toBeGreaterThan(0);
    // no code line lost
    for (let i = 0; i < 200; i++) {
      expect(chunks.join("\n")).toContain(`line_${i} = compute(${i})`);
    }
  });

  it("hard-cuts a single line longer than the limit", () => {
    const text = "x".repeat(5000);
    const chunks = splitMarkdownSafe(text, 2000);
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000);
    expect(chunks.join("")).toBe(text);
  });

  it("does not split inside a fence when the fence fits in one chunk", () => {
    const fence = "```js\nconst a = 1;\nconst b = 2;\n```";
    const text = `${"p ".repeat(900)}\n\n${fence}\n\nTail.`;
    const chunks = splitMarkdownSafe(text, 1900);
    const withFence = chunks.find(c => c.includes("const a = 1;"));
    expect(withFence).toBeDefined();
    expect(withFence).toContain("```js\nconst a = 1;\nconst b = 2;\n```");
  });

  it("handles CJK text (no word boundaries) by cutting at newlines", () => {
    const line = "中文内容测试".repeat(50); // 300 chars, no spaces
    const text = Array.from({ length: 10 }, () => line).join("\n");
    const chunks = splitMarkdownSafe(text, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000);
    expect(chunks.join("\n")).toBe(text); // cuts land on newlines, nothing lost
  });

  it("exports a default limit under Slack's 12k cumulative cap", () => {
    expect(MARKDOWN_SAFE_LIMIT).toBeLessThanOrEqual(11500);
    const text = "a".repeat(30000);
    for (const c of splitMarkdownSafe(text)) {
      expect(c.length).toBeLessThanOrEqual(MARKDOWN_SAFE_LIMIT);
    }
  });
});

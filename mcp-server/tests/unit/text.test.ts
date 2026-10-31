import { describe, expect, it } from "vitest";
import { escapeLike, excerpt, normalizeQuery, splitQuestions, tokenize, toWebSearchQuery } from "../../src/utils/text";

describe("text utils", () => {
  it("normalises unicode and whitespace", () => {
    expect(normalizeQuery("  photo \n\t synthesis ")).toBe("photo synthesis");
    // composed vs decomposed forms compare equal after NFC
    expect(normalizeQuery("é")).toBe(normalizeQuery("é"));
  });

  it("escapes LIKE metacharacters", () => {
    expect(escapeLike("100%_a\\b")).toBe("100\\%\\_a\\\\b");
  });

  it("tokenises Assamese words including combining vowel signs", () => {
    expect(tokenize("সৰল অসমীয়া সাহিত্য, class 9!")).toEqual(["সৰল", "অসমীয়া", "সাহিত্য", "class", "9"]);
  });

  it("keeps short queries AND-ed and turns long questions into OR queries", () => {
    expect(toWebSearchQuery("photosynthesis process")).toBe("photosynthesis process");
    expect(toWebSearchQuery("what is the process of photosynthesis in green plants")).toBe("process or photosynthesis or green or plants");
  });

  it("drops question words, in English and Assamese, but keeps them if nothing else remains", () => {
    expect(toWebSearchQuery("প্ৰতিফলন কি?")).toBe("প্ৰতিফলন");
    expect(toWebSearchQuery("what is the")).toBe("what or is or the");
  });

  it("drops one-character tokens and caps the term count", () => {
    expect(toWebSearchQuery("a b cd")).toBe("cd");
    const many = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    expect(toWebSearchQuery(many).split(" or ")).toHaveLength(12);
  });

  it("truncates at a word boundary without splitting multi-code-unit characters", () => {
    const r = excerpt("alpha beta gamma delta epsilon", 14);
    expect(r.truncated).toBe(true);
    expect(r.text).toBe("alpha beta …");
    expect(excerpt("short", 100)).toEqual({ text: "short", truncated: false });
    expect(excerpt("😀".repeat(10), 5).text.startsWith("😀😀😀😀😀")).toBe(true);
  });

  it("splits numbered questions in English, Assamese digits and sub-parts", () => {
    const qs = splitQuestions("1. What is force?\nstate its unit.\n২. নিউটনৰ সূত্ৰ লিখা।\n(a) Define mass");
    expect(qs.map((q) => q.number)).toEqual(["1", "২", "(a)"]);
    expect(qs[0]!.text).toBe("What is force? state its unit.");
    expect(splitQuestions("plain paragraph without numbers")).toEqual([]);
  });
});

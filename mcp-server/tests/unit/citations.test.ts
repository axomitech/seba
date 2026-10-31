import { describe, expect, it } from "vitest";
import { buildCitation, citedRefs, validateCitations, type SourceRef } from "../../src/services/citations";

const ref: Omit<SourceRef, "ref"> = {
  textbook_id: "id", title: "Beehive", class: "IX", subject: "English", medium: "All mediums",
  chapter_number: "3", chapter_title: "The Little Girl", pdf_page_start: 14, pdf_page_end: 15, printed_page_start: "5", source_pdf_url: null,
};

describe("citations", () => {
  it("builds a deterministic citation from metadata", () => {
    expect(buildCitation(ref)).toBe("Beehive — Class IX, English (All mediums), Chapter 3: The Little Girl, PDF pp. 14–15 (printed p. 5)");
    expect(buildCitation({ ...ref, chapter_title: null, pdf_page_end: 14, printed_page_start: null }))
      .toBe("Beehive — Class IX, English (All mediums), PDF p. 14");
  });
  it("extracts cited handles once", () => {
    expect(citedRefs("A [S1] and B [S2][S1].")).toEqual(["S1", "S2"]);
  });
  it("strips handles that were never retrieved", () => {
    const r = validateCitations("Light travels fast [S1]. Also [S7] says so [S2].", new Set(["S1", "S2"]));
    expect(r.valid).toEqual(["S1", "S2"]);
    expect(r.invalid).toEqual(["S7"]);
    expect(r.cleaned).not.toContain("S7");
    expect(r.cleaned).toContain("[S1]");
  });
});

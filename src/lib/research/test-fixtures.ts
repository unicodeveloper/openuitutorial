import type { EvidenceSource } from "./types";

export const instant = "2026-10-14T12:00:00.000Z";
export const vendorResult = (extra: Record<string, unknown> = {}) => ({
  id: "vendor-id", title: "Science museum", url: "https://example.org/museum?lang=en#exhibits", content: "Hands-on science exhibits.",
  source: "web", price: 0.001, length: 26, data_type: "unstructured", source_type: "website", ...extra,
});
export const vendorEnvelope = (extra: Record<string, unknown> = {}) => ({
  success: true, tx_id: "private-transaction", query: "fixture", results: [vendorResult()], results_by_source: {},
  total_deduction_dollars: 0.001, total_characters: 26, ...extra,
});
// Synthetic golden fixture for the documented successful response shape.
export const representativeVerifiedResponseShape = vendorEnvelope({
  tx_id: "synthetic-transaction-001",
  query: "example activities",
  results: ["forum", "forum", "website"].map((source_type, index) => {
    const content = `Example activity ${index + 1} has a plain-text description. `.repeat(40);
    return vendorResult({
      id: `synthetic-result-${index + 1}`,
      title: `Example activity ${index + 1}`,
      url: `https://example.org/activities/${index + 1}`,
      content,
      length: content.length,
      source_type,
      price: 0.0015,
    });
  }),
  total_deduction_dollars: 0.0045,
  total_characters: [1, 2, 3].reduce((total, index) => total + `Example activity ${index} has a plain-text description. `.repeat(40).length, 0),
});
export const source: EvidenceSource = {
  id: "s1", title: "Science museum", url: "https://example.org/museum", source: "web", excerpt: "Hands-on science exhibits.",
  publicationDate: null, retrievedAt: instant, relevanceScore: null,
};
export const options = [{ id: "c1", label: "Science museum", claims: [{ criterion: "Activities", statement: "The excerpt describes hands-on science exhibits.", sourceIds: ["s1"], evidenceStatus: "supported" }] }];

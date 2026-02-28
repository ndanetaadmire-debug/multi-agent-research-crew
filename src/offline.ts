/**
 * Deterministic, offline implementations of every role, so the crew runs end-to-end
 * with no API key (demo + CI). Each is a drop-in for an LLM-backed implementation.
 */
import type { Claim, Critic, Finding, Planner, Researcher, SearchTool, Source, Writer } from "./types.js";
import { terms } from "./verify.js";

export class InMemorySearch implements SearchTool {
  constructor(private readonly corpus: Source[]) {}
  async search(query: string, k: number): Promise<Source[]> {
    const q = new Set(terms(query));
    return this.corpus
      .map((s) => ({ s, score: terms(`${s.title} ${s.content}`).filter((t) => q.has(t)).length }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((x) => x.s);
  }
}

export class SplitPlanner implements Planner {
  async plan(question: string, max: number) {
    const base = question.replace(/\?$/, "");
    const parts = base.split(/,| and /i).map((p) => p.trim()).filter((p) => p.split(" ").length >= 2);
    return { subQuestions: (parts.length > 1 ? parts : [base]).slice(0, max), usage: { inputTokens: 50, outputTokens: 20 } };
  }
}

export class ExtractiveResearcher implements Researcher {
  async research(subQuestion: string, sources: Source[]) {
    const q = new Set(terms(subQuestion));
    const claims: Claim[] = [];
    for (const s of sources) {
      const min = Math.max(1, Math.ceil(q.size / 3));
      const relevant = s.content
        .split(/(?<=\.)\s+/)
        .map((sent) => ({ sent, score: terms(sent).filter((t) => q.has(t)).length }))
        .filter((x) => x.score >= min)
        .sort((a, b) => b.score - a.score)
        .slice(0, 2);
      for (const r of relevant) claims.push({ text: r.sent, sourceIds: [s.id] });
    }
    return { claims: claims.slice(0, 4), usage: { inputTokens: 400, outputTokens: 80 } };
  }
}

export class CoverageCritic implements Critic {
  async review(_question: string, findings: Finding[]) {
    const gaps = findings.filter((f) => f.claims.length === 0).map((f) => `background on ${f.subQuestion}`);
    return { review: { gaps, notes: gaps.length ? "Some sub-questions have no verified evidence." : "Coverage is adequate." }, usage: { inputTokens: 300, outputTokens: 40 } };
  }
}

export class ConcatWriter implements Writer {
  async write(_question: string, claims: Array<Claim & { n: number }>) {
    return { text: claims.map((c) => `${c.text} [${c.n}]`).join(" "), usage: { inputTokens: 500, outputTokens: 150 } };
  }
}

export const DEMO_CORPUS: Source[] = [
  { id: "s1", title: "SARB monetary policy statement", url: "https://example.org/sarb-mps", content: "The South African Reserve Bank kept the repo rate at 7.25% at its latest meeting. Inflation is expected to stay within the 3 to 6% target range." },
  { id: "s2", title: "Load-shedding and business", url: "https://example.org/eskom-impact", content: "Reduced load-shedding in 2025 lowered diesel costs for small businesses. Retailers reported fewer trading hours lost to outages." },
  { id: "s3", title: "E-commerce in South Africa", url: "https://example.org/za-ecommerce", content: "Online retail in South Africa grew 24% in 2024 according to industry estimates. Mobile devices account for most online purchases." },
  { id: "s4", title: "Courier market overview", url: "https://example.org/couriers", content: "Same-day delivery is now common in Johannesburg and Cape Town. Delivery costs remain a barrier in rural areas." },
];

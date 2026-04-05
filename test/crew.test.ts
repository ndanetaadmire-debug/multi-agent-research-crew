import { describe, expect, it } from "vitest";
import { buildCrew, type Budget } from "../src/graph.js";
import { ConcatWriter, CoverageCritic, DEMO_CORPUS, ExtractiveResearcher, InMemorySearch, SplitPlanner } from "../src/offline.js";
import type { Claim, Crew, Finding, Review, Source } from "../src/types.js";
import { verifyClaim } from "../src/verify.js";

const BUDGET: Budget = { maxSubQuestions: 4, maxRounds: 2, maxTokens: 50_000, sourcesPerQuestion: 2 };
const SRC: Source = { id: "a", title: "A", url: "https://a.example", content: "Online retail in South Africa grew 24% in 2024. Mobile devices drive most purchases." };

describe("claim verification", () => {
  it("accepts supported claims and rejects invented sources, unsupported text and invented numbers", () => {
    expect(verifyClaim({ text: "Online retail in South Africa grew 24% in 2024", sourceIds: ["a"] }, [SRC]).verified).toBe(true);
    expect(verifyClaim({ text: "Retail grew", sourceIds: [] }, [SRC]).reason).toBe("no citation");
    expect(verifyClaim({ text: "Retail grew 24%", sourceIds: ["zz"] }, [SRC]).reason).toMatch(/unknown source/);
    expect(verifyClaim({ text: "Drone deliveries replaced couriers nationwide", sourceIds: ["a"] }, [SRC]).reason).toMatch(/appears in its sources/);
    expect(verifyClaim({ text: "Online retail in South Africa grew 42% in 2024", sourceIds: ["a"] }, [SRC]).reason).toMatch(/numbers not in source: 42%/);
  });
});

function scripted(over: Partial<Crew> & { reviews?: Review[] } = {}): Crew & { calls: Record<string, number> } {
  const calls = { plan: 0, research: 0, critic: 0, write: 0 };
  const reviews = [...(over.reviews ?? [{ gaps: [], notes: "" }])];
  return {
    calls,
    search: over.search ?? new InMemorySearch(DEMO_CORPUS),
    planner: over.planner ?? { plan: async () => (calls.plan++, { subQuestions: ["online retail growth", "online retail growth ", "delivery costs rural"], usage: { inputTokens: 10, outputTokens: 10 } }) },
    researcher: over.researcher ?? new ExtractiveResearcher(),
    critic: over.critic ?? { review: async (_q: string, _f: Finding[]) => (calls.critic++, { review: reviews.shift() ?? { gaps: [], notes: "" }, usage: { inputTokens: 10, outputTokens: 10 } }) },
    writer: over.writer ?? { write: async (q: string, claims: Array<Claim & { n: number }>) => (calls.write++, new ConcatWriter().write(q, claims)) },
  };
}

describe("crew graph", () => {
  it("fans out deduplicated sub-questions in parallel, critiques once, writes a cited report", async () => {
    const crew = scripted();
    const out = await buildCrew(crew, BUDGET).invoke({ question: "How is online retail growing and what does delivery cost?" });
    expect(out.events.filter((e) => e.kind === "research")).toHaveLength(2); // duplicate sub-question removed
    expect(crew.calls.critic).toBe(1);
    expect(out.stopReason).toBe("complete");
    expect(out.report).toMatch(/grew 24% in 2024[^[]*\[1\]/);
    expect(out.report).toMatch(/## Sources\n\[\d\] .* — https:\/\/example\.org\//);
    expect(out.usage.inputTokens).toBeGreaterThan(0);
  });

  it("drops a hallucinating researcher's claims and says so in Limitations", async () => {
    const crew = scripted({
      researcher: { research: async (_q, sources) => ({ claims: [
        { text: sources[0]!.content.split(". ")[0]!, sourceIds: [sources[0]!.id] },
        { text: "Online retail grew 300% in 2024", sourceIds: [sources[0]!.id] },
        { text: "Experts agree delivery is free everywhere", sourceIds: ["https://made-up.example"] },
      ] }) },
    });
    const out = await buildCrew(crew, BUDGET).invoke({ question: "online retail" });
    expect(out.report).not.toMatch(/300%|free everywhere/);
    expect(out.rejected.length).toBeGreaterThanOrEqual(2);
    expect(out.report).toMatch(/## Limitations\n- \d+ claim\(s\) were discarded/);
  });

  it("revises: the critic's gaps trigger another research round, bounded by maxRounds", async () => {
    const crew = scripted({ reviews: [{ gaps: ["load-shedding diesel costs small businesses"], notes: "" }, { gaps: ["courier same-day Johannesburg"], notes: "" }] });
    const out = await buildCrew(crew, { ...BUDGET, maxRounds: 2 }).invoke({ question: "retail" });
    const researched = out.events.filter((e) => e.kind === "research").map((e) => (e as { subQuestion: string }).subQuestion);
    expect(researched).toContain("load-shedding diesel costs small businesses");
    expect(researched).not.toContain("courier same-day Johannesburg");
    expect(out.stopReason).toBe("max_rounds");
    expect(out.report).toMatch(/Open questions not researched: courier same-day Johannesburg/);
  });

  it("stops at the token budget and still produces an honest report", async () => {
    const out = await buildCrew(scripted(), { ...BUDGET, maxTokens: 100 }).invoke({ question: "online retail growth" });
    expect(out.stopReason).toBe("token_budget");
    expect(out.report).toMatch(/Stopped early: token budget reached/);
  });

  it("never re-asks a question it already researched", async () => {
    const crew = scripted({ reviews: [{ gaps: ["Online retail growth", "online retail growth?"], notes: "" }] });
    const out = await buildCrew(crew, BUDGET).invoke({ question: "x" });
    expect(out.stopReason).toBe("complete");
    expect(crew.calls.critic).toBe(1);
  });

  it("handles no evidence at all", async () => {
    const crew = scripted({ search: { search: async () => [] } });
    const out = await buildCrew(crew, { ...BUDGET, maxRounds: 1 }).invoke({ question: "quantum gravity" });
    expect(out.report).toMatch(/No verified findings/);
    expect(crew.calls.write).toBe(0);
  });

  it("offline crew runs end to end", async () => {
    const out = await buildCrew(
      { planner: new SplitPlanner(), researcher: new ExtractiveResearcher(), critic: new CoverageCritic(), writer: new ConcatWriter(), search: new InMemorySearch(DEMO_CORPUS) },
      BUDGET,
    ).invoke({ question: "How is online retail growing in South Africa, and what limits delivery?" });
    expect(out.report).toContain("Delivery costs remain a barrier in rural areas");
    expect(out.report).not.toContain("repo rate");
  });
});

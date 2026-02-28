import { Annotation, END, Send, START, StateGraph } from "@langchain/langgraph";
import type { Claim, Crew, Finding, Source, Usage } from "./types.js";
import { verifyClaim, type Verdict } from "./verify.js";

export interface Budget {
  maxSubQuestions: number;
  maxRounds: number; // research → critique cycles
  maxTokens: number;
  sourcesPerQuestion: number;
}

export type CrewEvent =
  | { kind: "plan"; round: number; subQuestions: string[] }
  | { kind: "research"; subQuestion: string; verified: number; rejected: number }
  | { kind: "critique"; round: number; gaps: string[] }
  | { kind: "stop"; reason: "complete" | "max_rounds" | "token_budget" }
  | { kind: "write"; claims: number };

const append = <T>(a: T[], b: T[]) => a.concat(b);
const addUsage = (a: Usage, b: Usage): Usage => ({ inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens });

export const CrewState = Annotation.Root({
  question: Annotation<string>({ reducer: (_a, b) => b, default: () => "" }),
  pending: Annotation<string[]>({ reducer: (_a, b) => b, default: () => [] }),
  asked: Annotation<string[]>({ reducer: append, default: () => [] }),
  current: Annotation<string>({ reducer: (_a, b) => b, default: () => "" }),
  findings: Annotation<Finding[]>({ reducer: append, default: () => [] }),
  rejected: Annotation<Verdict[]>({ reducer: append, default: () => [] }),
  round: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
  usage: Annotation<Usage>({ reducer: addUsage, default: () => ({ inputTokens: 0, outputTokens: 0 }) }),
  stopReason: Annotation<"complete" | "max_rounds" | "token_budget" | null>({ reducer: (_a, b) => b, default: () => null }),
  openGaps: Annotation<string[]>({ reducer: (_a, b) => b, default: () => [] }),
  report: Annotation<string>({ reducer: (_a, b) => b, default: () => "" }),
  events: Annotation<CrewEvent[]>({ reducer: append, default: () => [] }),
});
type S = typeof CrewState.State;

const ZERO: Usage = { inputTokens: 0, outputTokens: 0 };
const spent = (s: S) => s.usage.inputTokens + s.usage.outputTokens;
const norm = (q: string) => q.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();

/**
 *   plan ──Send×N──▶ research (parallel) ──▶ critique ──┬─▶ research gaps (≤ maxRounds)
 *                                                       └─▶ write ─▶ END
 */
export function buildCrew(crew: Crew, budget: Budget) {
  const plan = async (s: S) => {
    const { subQuestions, usage } = await crew.planner.plan(s.question, budget.maxSubQuestions);
    const qs = dedupe(subQuestions, []).slice(0, budget.maxSubQuestions);
    return { pending: qs, asked: qs, round: 1, usage: usage ?? ZERO, events: [{ kind: "plan" as const, round: 1, subQuestions: qs }] };
  };

  const research = async (s: S) => {
    const sources: Source[] = await crew.search.search(s.current, budget.sourcesPerQuestion);
    const { claims, usage } = await crew.researcher.research(s.current, sources);
    const verdicts = claims.map((c) => verifyClaim(c, sources));
    const good = verdicts.filter((v) => v.verified).map((v) => v.claim);
    const bad = verdicts.filter((v) => !v.verified);
    return {
      findings: [{ subQuestion: s.current, claims: good, sources }],
      rejected: bad,
      usage: usage ?? ZERO,
      events: [{ kind: "research" as const, subQuestion: s.current, verified: good.length, rejected: bad.length }],
    };
  };

  const critique = async (s: S) => {
    if (spent(s) >= budget.maxTokens) {
      return { pending: [], stopReason: "token_budget" as const, events: [{ kind: "stop" as const, reason: "token_budget" as const }] };
    }
    const { review, usage } = await crew.critic.review(s.question, s.findings);
    const gaps = dedupe(review.gaps, s.asked).slice(0, budget.maxSubQuestions);
    const events: S["events"] = [{ kind: "critique", round: s.round, gaps }];
    if (gaps.length === 0) return { pending: [], openGaps: [], stopReason: "complete" as const, usage: usage ?? ZERO, events: [...events, { kind: "stop", reason: "complete" }] };
    if (s.round >= budget.maxRounds) return { pending: [], openGaps: gaps, stopReason: "max_rounds" as const, usage: usage ?? ZERO, events: [...events, { kind: "stop", reason: "max_rounds" }] };
    return { pending: gaps, asked: gaps, round: 1, usage: usage ?? ZERO, events };
  };

  const write = async (s: S) => {
    // Number sources 1..n in order of first citation, so references are contiguous and stable.
    const allSources = new Map(s.findings.flatMap((f) => f.sources).map((src) => [src.id, src]));
    const sourceIndex = new Map<string, number>();
    const verified = s.findings.flatMap((f) => f.claims);
    for (const c of verified) for (const id of c.sourceIds) if (!sourceIndex.has(id)) sourceIndex.set(id, sourceIndex.size + 1);
    const sources = [...sourceIndex.keys()].map((id) => allSources.get(id)!);
    const claims: Array<Claim & { n: number }> = verified.map((c) => ({ ...c, n: sourceIndex.get(c.sourceIds[0]!)! }));
    const { text, usage } = claims.length
      ? await crew.writer.write(s.question, claims)
      : { text: "No verified findings were produced for this question.", usage: ZERO };

    const used = new Set([...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
    const refs = sources.filter((_, i) => used.has(i + 1)).map((src) => `[${sourceIndex.get(src.id)}] ${src.title} — ${src.url}`);
    const limits: string[] = [];
    if (s.stopReason === "token_budget") limits.push("Stopped early: token budget reached.");
    if (s.stopReason === "max_rounds" && s.openGaps.length) limits.push(`Open questions not researched: ${s.openGaps.join("; ")}.`);
    if (s.rejected.length) limits.push(`${s.rejected.length} claim(s) were discarded because their sources did not support them.`);

    const report = [`# ${s.question}`, "", text, "", "## Sources", ...(refs.length ? refs : ["(none)"]),
      ...(limits.length ? ["", "## Limitations", ...limits.map((l) => `- ${l}`)] : [])].join("\n");
    return { report, usage: usage ?? ZERO, events: [{ kind: "write" as const, claims: claims.length }] };
  };

  const fanOut = (s: S) => s.pending.map((q) => new Send("research", { ...s, current: q }));

  return new StateGraph(CrewState)
    .addNode("plan", plan)
    .addNode("research", research)
    .addNode("critique", critique)
    .addNode("write", write)
    .addEdge(START, "plan")
    .addConditionalEdges("plan", (s) => (s.pending.length ? fanOut(s) : "write"), ["research", "write"])
    .addEdge("research", "critique")
    .addConditionalEdges("critique", (s) => (s.pending.length ? fanOut(s) : "write"), ["research", "write"])
    .addEdge("write", END)
    .compile();
}

function dedupe(qs: string[], already: string[]): string[] {
  const seen = new Set(already.map(norm));
  const out: string[] = [];
  for (const q of qs) {
    const k = norm(q);
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(q.trim());
    }
  }
  return out;
}

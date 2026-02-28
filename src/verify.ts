import type { Claim, Source } from "./types.js";

const STOP = new Set("a an and are as at be by for from has have in is it its of on or that the this to was were will with which who".split(" "));
export const terms = (s: string) => (s.toLowerCase().match(/[a-z0-9]+(?:\.[0-9]+)?%?/g) ?? []).filter((t) => !STOP.has(t));

export interface Verdict {
  claim: Claim;
  verified: boolean;
  reason?: string;
}

/**
 * Deterministic citation check, run in code after every researcher:
 *   1. every cited source must be one the researcher was actually given (no invented URLs);
 *   2. the cited sources must contain most of the claim's content words;
 *   3. every number in the claim must appear in a cited source (numbers are where models invent most).
 * Cheap, explainable, and it doesn't ask a model to grade its own homework.
 */
export function verifyClaim(claim: Claim, available: Source[], threshold = 0.6): Verdict {
  if (claim.sourceIds.length === 0) return { claim, verified: false, reason: "no citation" };
  const byId = new Map(available.map((s) => [s.id, s]));
  const unknown = claim.sourceIds.filter((id) => !byId.has(id));
  if (unknown.length) return { claim, verified: false, reason: `cites unknown source ${unknown.join(", ")}` };

  const evidence = claim.sourceIds.map((id) => byId.get(id)!.content).join(" ");
  const evTerms = new Set(terms(evidence));
  const cTerms = terms(claim.text);
  const support = cTerms.filter((t) => evTerms.has(t)).length / Math.max(1, cTerms.length);
  if (support < threshold) return { claim, verified: false, reason: `only ${Math.round(support * 100)}% of the claim appears in its sources` };

  const numbers = claim.text.match(/\d+(?:[.,]\d+)?%?/g) ?? [];
  const missing = numbers.filter((n) => !evidence.includes(n));
  if (missing.length) return { claim, verified: false, reason: `numbers not in source: ${missing.join(", ")}` };
  return { claim, verified: true };
}

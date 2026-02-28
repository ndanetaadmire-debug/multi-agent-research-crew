import { buildCrew } from "./graph.js";
import { ConcatWriter, CoverageCritic, DEMO_CORPUS, ExtractiveResearcher, InMemorySearch, SplitPlanner } from "./offline.js";

const question = process.argv.slice(2).join(" ") || "How is online retail growing in South Africa, and what limits delivery?";
const crew = buildCrew(
  { planner: new SplitPlanner(), researcher: new ExtractiveResearcher(), critic: new CoverageCritic(), writer: new ConcatWriter(), search: new InMemorySearch(DEMO_CORPUS) },
  { maxSubQuestions: 4, maxRounds: 2, maxTokens: 20_000, sourcesPerQuestion: 2 },
);
const out = await crew.invoke({ question });
for (const e of out.events) console.error("·", JSON.stringify(e));
console.log(`\n${out.report}\n\ntokens: ${out.usage.inputTokens} in / ${out.usage.outputTokens} out`);

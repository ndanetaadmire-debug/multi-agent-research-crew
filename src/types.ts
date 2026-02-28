export interface Source {
  id: string;
  title: string;
  url: string;
  content: string;
}

export interface Claim {
  text: string;
  sourceIds: string[];
}

export interface Finding {
  subQuestion: string;
  claims: Claim[];
  sources: Source[];
}

export interface Review {
  gaps: string[]; // follow-up sub-questions the critic wants answered
  notes: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** Each role is a port. Production: an LLM per role (often a cheaper model for researchers). Tests: scripted. */
export interface Planner {
  plan(question: string, maxSubQuestions: number): Promise<{ subQuestions: string[]; usage?: Usage }>;
}
export interface Researcher {
  research(subQuestion: string, sources: Source[]): Promise<{ claims: Claim[]; usage?: Usage }>;
}
export interface Critic {
  review(question: string, findings: Finding[]): Promise<{ review: Review; usage?: Usage }>;
}
export interface Writer {
  write(question: string, claims: Array<Claim & { n: number }>): Promise<{ text: string; usage?: Usage }>;
}
export interface SearchTool {
  search(query: string, k: number): Promise<Source[]>;
}

export interface Crew {
  planner: Planner;
  researcher: Researcher;
  critic: Critic;
  writer: Writer;
  search: SearchTool;
}

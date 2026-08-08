import type { ContextRecord, ContextScope, ContextStore } from "./context.js";

export type CognitiveInput = {
  text: string;
  scope: ContextScope;
  replyTo?: string;
  recentTasks?: Array<{ id: string; text: string; status: string }>;
  abilityNames: string[];
};

export type GroundedPlan = {
  goal: string;
  steps: string[];
  contextIds: string[];
  contextSources: string[];
};

export interface CognitiveModel {
  planQueries(input: CognitiveInput): Promise<string[]>;
  decide(input: CognitiveInput, context: ContextRecord[]): Promise<Omit<GroundedPlan, "contextIds" | "contextSources">>;
}

export class GroundedPlanner {
  constructor(
    private readonly context: ContextStore,
    private readonly model: CognitiveModel = new DeterministicCognitiveModel(),
  ) {}

  async plan(input: CognitiveInput): Promise<GroundedPlan> {
    const queries = (await this.model.planQueries(input)).slice(0, 4);
    const recordsById = new Map<string, ContextRecord>();
    for (const query of queries) {
      for (const record of await this.context.search(query, input.scope)) {
        recordsById.set(record.id, record);
      }
    }
    const records = [...recordsById.values()].slice(0, 8);
    const decision = await this.model.decide(input, records);
    return {
      ...decision,
      contextIds: records.map((record) => record.id),
      contextSources: records.flatMap((record) => record.sources.map((source) => source.ref)),
    };
  }
}

export class DeterministicCognitiveModel implements CognitiveModel {
  async planQueries(input: CognitiveInput): Promise<string[]> {
    return [input.text];
  }

  async decide(input: CognitiveInput, context: ContextRecord[]) {
    return {
      goal: input.text,
      steps: context.length
        ? ["Use confirmed Context", "Execute the matched ability", "Verify and review the result"]
        : ["Execute the matched ability", "Verify and review the result"],
    };
  }
}

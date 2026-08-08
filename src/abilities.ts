import type { AgentResult, RiskLevel, TaskRecord } from "./protocol.js";

export type Ability = {
  name: string;
  description: string;
  risk: RiskLevel;
  triggers: RegExp[];
  requiredInputs?: string[];
  executionContract: string;
  verificationContract: {
    requiredFacts: string[];
    requireExternalReadback: boolean;
    requireWriteback?: boolean;
  };
  reviewerChecklist: string[];
  execute(task: TaskRecord): Promise<AgentResult>;
  review(task: TaskRecord): Promise<AgentResult>;
};

export class AbilityRegistry {
  private readonly abilities = new Map<string, Ability>();

  register(ability: Ability): this {
    if (this.abilities.has(ability.name)) {
      throw new Error(`ability_already_registered:${ability.name}`);
    }
    this.abilities.set(ability.name, ability);
    return this;
  }

  get(name: string): Ability {
    const ability = this.abilities.get(name);
    if (!ability) throw new Error(`unknown_ability:${name}`);
    return ability;
  }

  match(text: string): Ability | undefined {
    return [...this.abilities.values()].find((ability) =>
      ability.triggers.some((trigger) => trigger.test(text)),
    );
  }

  list(): Ability[] {
    return [...this.abilities.values()];
  }
}

export function verifyAbilityResult(
  ability: Ability,
  result: AgentResult,
): AgentResult & { state: "verified" | "rejected" | "uncertain" } {
  if (!result.ok) return { ...result, state: "rejected" };
  if (result.externalState === "unknown") return { ...result, state: "uncertain" };
  const missing = ability.verificationContract.requiredFacts.filter(
    (key) => result.facts?.[key] === undefined,
  );
  if (ability.verificationContract.requireExternalReadback) {
    if (result.externalState !== "verified" || !result.externalReferences?.length) {
      missing.push("external_readback");
    }
  }
  if (
    ability.verificationContract.requireWriteback &&
    result.writebackState !== "verified"
  ) {
    return {
      ...result,
      state: "rejected",
      blockers: [...(result.blockers ?? []), "writeback_pending"],
    };
  }
  return missing.length
    ? { ...result, state: "rejected", blockers: [...(result.blockers ?? []), ...missing] }
    : { ...result, state: "verified" };
}

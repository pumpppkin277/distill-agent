import "dotenv/config";
import { AbilityRegistry } from "./abilities.js";
import { GroundedPlanner } from "./cognitive.js";
import { SqliteContextStore } from "./context.js";
import { FeishuBot } from "./feishu.js";
import { DurableHarness } from "./harness.js";
import { startHealthServer } from "./ops.js";
import { DistillOrchestrator } from "./orchestrator.js";
import { HarnessStore } from "./store.js";

const appId = required("FEISHU_APP_ID");
const appSecret = required("FEISHU_APP_SECRET");
const store = new HarnessStore("data/harness.sqlite");
const context = new SqliteContextStore("data/context.sqlite");
const abilities = new AbilityRegistry().register({
  name: "safe_demo",
  description: "A safe example that demonstrates approval, execution, verification, and review.",
  risk: "medium",
  triggers: [/.+/],
  executionContract: "Return a deterministic demo artifact without external writes.",
  verificationContract: {
    requiredFacts: ["inputLength"],
    requireExternalReadback: false,
  },
  reviewerChecklist: ["Execution succeeded", "Evidence is present"],
  async execute(task) {
    return {
      ok: true,
      summary: `Demo Worker processed: ${task.text}`,
      evidence: [`task:${task.id}`],
      externalState: "not_applicable",
      writebackState: "not_applicable",
      facts: { inputLength: task.text.length },
    };
  },
  async review(task) {
    return {
      ok: Boolean(task.execution?.ok && task.execution.evidence.length),
      summary: "Independent Reviewer confirmed the result contains evidence.",
      evidence: task.execution?.evidence ?? [],
    };
  },
});
const harness = new DurableHarness(store, abilities, "data/checkpoints.sqlite");
const orchestrator = new DistillOrchestrator(
  abilities,
  new GroundedPlanner(context),
  harness,
  store,
);

const bot = new FeishuBot({ appId, appSecret }, async (message) => {
  if (message.messageId && !store.markMessageProcessed(message.messageId)) return undefined;
  const confirmation = message.text.match(/^confirm\s+([0-9a-f-]{36})$/i);
  const result = confirmation
    ? await orchestrator.confirm(confirmation[1], message.messageId)
    : await orchestrator.start({
        text: message.text,
        scope: {
          tenantId: message.tenantId,
          chatId: message.chatId,
          userId: message.senderId,
        },
        replyTo: message.parentMessageId ?? message.rootMessageId,
      });
  return result.message;
});

bot.start();
startHealthServer(store, { port: Number(process.env.HEALTH_PORT ?? 8787), context });
console.log("Distill Agent v0.2 is listening through Feishu long connection.");

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

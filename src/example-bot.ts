import "dotenv/config";
import { randomUUID } from "node:crypto";
import type { AgentTeam } from "./agents.js";
import { MemoryContextStore } from "./context.js";
import { FeishuBot } from "./feishu.js";
import { DistillRuntime } from "./runtime.js";

const appId = required("FEISHU_APP_ID");
const appSecret = required("FEISHU_APP_SECRET");
const context = new MemoryContextStore();

const team: AgentTeam = {
  planner: {
    async plan(request, records) {
      return {
        goal: request.text,
        steps: ["理解请求", "执行示例任务", "独立审核"],
        contextIds: records.map((record) => record.id),
      };
    },
  },
  worker: {
    async execute(request) {
      return {
        ok: true,
        summary: `示例 Worker 已处理：${request.text}`,
        evidence: [`task:${request.id}`],
      };
    },
  },
  reviewer: {
    async review(_request, result) {
      return {
        approved: result.ok && result.evidence.length > 0,
        summary: "Reviewer 已确认结果包含证据。",
      };
    },
  },
};

const runtime = new DistillRuntime(team, context);
const bot = new FeishuBot({ appId, appSecret }, async (message) => {
  const result = await runtime.run({
    id: message.messageId ?? randomUUID(),
    text: message.text,
    scope: {
      tenantId: message.tenantId,
      chatId: message.chatId,
      userId: message.senderId,
    },
    risk: "low",
  });
  return result.message;
});

bot.start();
console.log("Distill Agent is listening through Feishu long connection.");

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

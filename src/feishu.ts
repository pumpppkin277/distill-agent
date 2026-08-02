import * as lark from "@larksuiteoapi/node-sdk";

export type FeishuMessage = {
  tenantId: string;
  chatId: string;
  messageId?: string;
  senderId?: string;
  text: string;
};

export function parseFeishuMessage(data: any): FeishuMessage {
  const header = data?.header ?? data?.event?.header ?? {};
  const event = data?.event ?? data ?? {};
  const message = event.message ?? {};
  const sender = event.sender ?? {};
  return {
    tenantId: String(header.tenant_key ?? "default"),
    chatId: String(message.chat_id ?? ""),
    messageId: message.message_id ? String(message.message_id) : undefined,
    senderId: sender?.sender_id?.open_id ? String(sender.sender_id.open_id) : undefined,
    text: messageText(message.content),
  };
}

export class FeishuBot {
  private readonly client: lark.Client;

  constructor(
    private readonly config: { appId: string; appSecret: string },
    private readonly onMessage: (message: FeishuMessage) => Promise<string>,
  ) {
    this.client = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      appType: lark.AppType.SelfBuild,
    });
  }

  start(): void {
    const dispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: unknown) => {
        const message = parseFeishuMessage(data);
        if (!message.chatId || !message.text) return;
        const reply = await this.onMessage(message);
        await this.send(message.chatId, reply);
      },
    });
    new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: lark.LoggerLevel.info,
    }).start({ eventDispatcher: dispatcher });
  }

  async send(chatId: string, text: string): Promise<void> {
    await this.client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
  }
}

function messageText(content: unknown): string {
  if (typeof content !== "string") return "";
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === "string"
      ? parsed.text.replace(/<at[^>]*>.*?<\/at>/g, "").trim()
      : "";
  } catch {
    return content.trim();
  }
}

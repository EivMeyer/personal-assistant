import { z } from "zod";
import { requestJson, type Http } from "../http.ts";

const messageSchema = z.object({
  message_id: z.number().int(),
  chat: z.object({ id: z.number().int(), type: z.string() }),
  from: z
    .object({ id: z.number().int(), is_bot: z.boolean().optional() })
    .optional(),
  text: z.string().optional(),
  reply_to_message: z.object({ message_id: z.number().int() }).optional(),
});
export const updateSchema = z.object({
  update_id: z.number().int(),
  message: messageSchema.optional(),
  callback_query: z
    .object({
      id: z.string(),
      from: z.object({ id: z.number().int() }),
      data: z.string().optional(),
      message: messageSchema.optional(),
    })
    .optional(),
});
export type TelegramUpdate = z.infer<typeof updateSchema>;
export interface Messenger {
  send(payload: Record<string, unknown>): Promise<number>;
  answer(id: string, text: string): Promise<void>;
}
export class Telegram implements Messenger {
  constructor(
    private readonly settings: { token: string; chatId: number },
    private readonly http: Http = requestJson,
  ) {}
  private async call(method: string, body: unknown): Promise<unknown> {
    const result = z.object({ ok: z.boolean(), result: z.unknown() }).parse(
      await this.http(
        `https://api.telegram.org/bot${this.settings.token}/${method}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      ),
    );
    if (!result.ok) throw new Error("Telegram API rejected the request");
    return result.result;
  }
  async verify(): Promise<void> {
    z.object({ id: z.number(), is_bot: z.literal(true) }).parse(
      await this.call("getMe", {}),
    );
    const webhook = z
      .object({ url: z.string() })
      .parse(await this.call("getWebhookInfo", {}));
    if (webhook.url)
      throw new Error(
        "Telegram bot already has a webhook; use a dedicated bot or remove it explicitly",
      );
    const chat = z
      .object({ id: z.number(), type: z.literal("private") })
      .parse(await this.call("getChat", { chat_id: this.settings.chatId }));
    if (chat.id !== this.settings.chatId)
      throw new Error("Telegram chat identity mismatch");
  }
  async updates(offset: number): Promise<TelegramUpdate[]> {
    return z.array(updateSchema).parse(
      await this.call("getUpdates", {
        offset,
        timeout: 2,
        limit: 50,
        allowed_updates: ["message", "callback_query"],
      }),
    );
  }
  async send(payload: Record<string, unknown>): Promise<number> {
    const result = z.object({ message_id: z.number() }).parse(
      await this.call("sendMessage", {
        chat_id: this.settings.chatId,
        link_preview_options: { is_disabled: true },
        ...payload,
      }),
    );
    return result.message_id;
  }
  async answer(id: string, text: string): Promise<void> {
    await this.call("answerCallbackQuery", {
      callback_query_id: id,
      text: text.slice(0, 180),
    });
  }
}

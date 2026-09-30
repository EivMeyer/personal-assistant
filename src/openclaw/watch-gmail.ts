import { z } from "zod";
import { verifyMailbox, type MailClient } from "../adapters/google-client.ts";
import {
  changedMessages,
  isNotFound,
  recoverMessages,
} from "../adapters/gmail-sync.ts";
import type { Checkpoint, IncomingEvent } from "./watch-store.ts";
export interface Scan {
  cursor: string;
  events: IncomingEvent[];
}
export class GmailWatch {
  private verified = false;
  constructor(
    readonly source: string,
    private client: MailClient,
    private email: string,
    private startAt: number,
  ) {}
  async scan(checkpoint?: Checkpoint): Promise<Scan> {
    if (!this.verified) {
      await verifyMailbox(this.client, this.email);
      this.verified = true;
    }
    const changes = await this.changes(checkpoint);
    const events: IncomingEvent[] = [];
    for (const id of changes.ids) {
      const event = await this.read(id);
      if (event) events.push(event);
    }
    return { cursor: changes.cursor, events };
  }
  private async changes(checkpoint?: Checkpoint) {
    if (checkpoint) {
      try {
        return await changedMessages(this.client, checkpoint.cursor);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    // Take the history baseline before the overlapping recovery scan.
    const cursor = await verifyMailbox(this.client, this.email);
    const since = checkpoint ? checkpoint.checkedAt - 120_000 : this.startAt;
    return { cursor, ids: await recoverMessages(this.client, since) };
  }
  private async read(id: string): Promise<IncomingEvent | undefined> {
    try {
      const message = z
        .object({
          id: z.string(),
          threadId: z.string(),
          internalDate: z.string(),
          labelIds: z.array(z.string()).default([]),
        })
        .parse(
          await this.client.request(
            `messages/${encodeURIComponent(id)}?format=minimal`,
          ),
        );
      if (
        message.labelIds.some((label) =>
          ["SENT", "DRAFT", "SPAM", "TRASH"].includes(label),
        )
      )
        return;
      const receivedAt = Number(message.internalDate);
      if (!Number.isFinite(receivedAt)) throw Error("Invalid Gmail timestamp");
      return {
        source: this.source,
        id: message.id,
        thread: message.threadId,
        receivedAt,
      };
    } catch (error) {
      if (!isNotFound(error)) throw error;
      return;
    }
  }
}

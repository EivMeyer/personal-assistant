import { Store } from "../src/store.ts";
import { openDatabase } from "../src/database.ts";
import { Engine } from "../src/engine.ts";
import type {
  Assessment,
  Conversation,
  Planner,
  Proposal,
  Route,
  Source,
} from "../src/domain.ts";
import type { Messenger } from "../src/adapters/telegram.ts";

export function conversation(): Conversation {
  return {
    source: "fake",
    thread: "alice",
    complete: true,
    gaps: [],
    messages: [
      {
        id: "one",
        source: "fake",
        thread: "alice",
        channel: "whatsapp",
        timestamp: 1_000,
        sender: "Alice",
        body: "Can you send an update?",
        outgoing: false,
        automated: false,
        attachments: false,
      },
    ],
  };
}
export class FakeSource implements Source {
  id = "fake";
  context = conversation();
  sends: Proposal[] = [];
  sendError = false;
  verifyError = false;
  replyRoute: Route = {
    channel: "whatsapp",
    account: "fake",
    from: "Eivind",
    to: "Alice",
  };
  async poll(): Promise<void> {}
  async conversation(): Promise<Conversation> {
    return structuredClone(this.context);
  }
  async route(): Promise<Route> {
    return structuredClone(this.replyRoute);
  }
  async verify(): Promise<void> {
    if (this.verifyError) throw new Error("Wrong identity");
  }
  async send(proposal: Proposal): Promise<string> {
    this.sends.push(structuredClone(proposal));
    if (this.sendError) throw new Error("Response lost after send");
    return "fake:receipt";
  }
}
export class FakePlanner implements Planner {
  calls = 0;
  result: Assessment = {
    decision: "ask",
    reason: "Alice requested an update",
    question: null,
    draft: "I will send an update tomorrow.",
  };
  async assess(
    _context: Conversation,
    correction?: string,
  ): Promise<Assessment> {
    this.calls++;
    return {
      ...this.result,
      draft: correction ? "I will send an update Friday." : this.result.draft,
    };
  }
}
export class FakeMessenger implements Messenger {
  messages: Record<string, unknown>[] = [];
  failures = 0;
  async send(payload: Record<string, unknown>): Promise<number> {
    if (this.failures > 0) {
      this.failures--;
      throw new Error("Telegram unavailable");
    }
    this.messages.push(payload);
    return this.messages.length;
  }
  async answer(): Promise<void> {}
}
export function harness(mode: "live" | "preview" = "live") {
  const store = new Store(openDatabase(":memory:"));
  const source = new FakeSource();
  const planner = new FakePlanner();
  let now = 50_000;
  const engine = new Engine(store, new Map([[source.id, source]]), planner, {
    mode,
    approvalHours: 24,
    maxContextChars: 80_000,
    maxAssessmentsPerDay: 100,
    mutedThreads: [],
    now: () => now,
  });
  return {
    store,
    source,
    planner,
    engine,
    advance: (ms: number) => {
      now += ms;
    },
    close: () => store.db.close(),
    propose: async () => {
      store.schedule("fake", "alice", now);
      await engine.processJobs();
      return store.proposals(["pending", "needs_input"])[0]!;
    },
  };
}

import { Preferences } from "@capacitor/preferences";

// Local queue of usage events, flushed to /mobile/usage-report by flush.ts.
// Stored in Preferences (not localStorage) for consistency with config.ts,
// and because these events can contain real query/question text — the user
// explicitly chose full detail over anonymized/aggregated tracking.

const QUEUE_KEY = "pieces-android:usageQueue";
const MAX_QUEUE_SIZE = 500; // backstop against unbounded growth if flush stays broken for a long time
let pendingMutation: Promise<void> = Promise.resolve();

export type UsageEvent =
  | { type: "ask"; screen: "ask"; query: string; result: "answered" | "unavailable" | "error"; timestamp: string }
  | { type: "search"; screen: "recent"; query: string; resultCount: number; mode: "relevant" | "text" | "text-fallback"; timestamp: string }
  | { type: "screen_view"; screen: "setup" | "status" | "recent" | "ask"; timestamp: string }
  | { type: "setup_saved"; screen: "setup"; mode: "lan" | "remote"; timestamp: string };

export type QueuedUsageEvent = UsageEvent & { _queueId?: string };

async function readQueue(): Promise<QueuedUsageEvent[]> {
  const { value } = await Preferences.get({ key: QUEUE_KEY });
  if (!value) return [];
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

async function writeQueue(events: QueuedUsageEvent[]): Promise<void> {
  await Preferences.set({ key: QUEUE_KEY, value: JSON.stringify(events) });
}

function mutateQueue(operation: () => Promise<void>): Promise<void> {
  const mutation = pendingMutation.then(operation);
  pendingMutation = mutation.catch(() => {});
  return mutation;
}

export function recordEvent(event: UsageEvent): Promise<void> {
  return mutateQueue(async () => {
    const queue = await readQueue();
    queue.push({ ...event, _queueId: crypto.randomUUID() });
    if (queue.length > MAX_QUEUE_SIZE) queue.splice(0, queue.length - MAX_QUEUE_SIZE);
    await writeQueue(queue);
  });
}

export function peekQueue(): Promise<QueuedUsageEvent[]> {
  let snapshot: QueuedUsageEvent[] = [];
  return mutateQueue(async () => {
    const queue = await readQueue();
    if (queue.some((event) => !event._queueId)) {
      for (const event of queue) event._queueId ||= crypto.randomUUID();
      await writeQueue(queue);
    }
    snapshot = queue;
  }).then(() => snapshot);
}

/** Removes only acknowledged events — only call after a confirmed 2xx report. */
export function clearSentEvents(sentEvents: QueuedUsageEvent[]): Promise<void> {
  const sentIds = new Set(sentEvents.map((event) => event._queueId));
  return mutateQueue(async () => {
    const queue = await readQueue();
    await writeQueue(queue.filter((event) => !event._queueId || !sentIds.has(event._queueId)));
  });
}

export function classifyMode(baseUrl: string): "lan" | "remote" {
  return /^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(baseUrl) ? "lan" : "remote";
}

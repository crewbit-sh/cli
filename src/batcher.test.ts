import type { JobEvent } from "@crewbit/protocol";
import { describe, expect, test } from "vitest";
import { createBatcher, MAX_BATCH } from "./batcher.ts";

function collect() {
  const sent: Array<{ seq: number; events: JobEvent[] }> = [];
  return { sent, onFlush: (seq: number, events: JobEvent[]) => sent.push({ seq, events }) };
}

const say = (text: string): JobEvent => ({ t: "assistant", text });

describe("createBatcher", () => {
  test("holds an event rather than sending a frame for each one", () => {
    const { sent, onFlush } = collect();
    const batcher = createBatcher(onFlush, { intervalMs: 10_000 });

    batcher.push(say("one"));

    expect(sent).toHaveLength(0);
    batcher.stop();
  });

  test("sends once the batch is full", () => {
    const { sent, onFlush } = collect();
    const batcher = createBatcher(onFlush, { intervalMs: 10_000 });

    for (let i = 0; i < MAX_BATCH; i++) batcher.push(say(`e${i}`));

    expect(sent).toHaveLength(1);
    expect(sent[0]?.events).toHaveLength(MAX_BATCH);
    batcher.stop();
  });

  test("numbers batches monotonically, so the server can order and detect loss", () => {
    const { sent, onFlush } = collect();
    const batcher = createBatcher(onFlush, { intervalMs: 10_000 });

    batcher.push(say("a"));
    batcher.flush();
    batcher.push(say("b"));
    batcher.flush();

    expect(sent.map((s) => s.seq)).toEqual([1, 2]);
    batcher.stop();
  });

  test("flushing with nothing pending sends no frame", () => {
    const { sent, onFlush } = collect();
    const batcher = createBatcher(onFlush, { intervalMs: 10_000 });

    batcher.flush();
    batcher.flush();

    expect(sent).toHaveLength(0);
    batcher.stop();
  });

  test("sends on its own after the interval, so a quiet stage still reports", async () => {
    const { sent, onFlush } = collect();
    const batcher = createBatcher(onFlush, { intervalMs: 20 });

    batcher.push(say("slow"));
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(sent).toHaveLength(1);
    batcher.stop();
  });

  test("stopping sends what is pending, so the tail of a Job is not lost", () => {
    const { sent, onFlush } = collect();
    const batcher = createBatcher(onFlush, { intervalMs: 10_000 });
    batcher.push(say("last words"));

    batcher.stop();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.events).toEqual([say("last words")]);
  });

  test("stopping twice sends nothing the second time", () => {
    const { sent, onFlush } = collect();
    const batcher = createBatcher(onFlush, { intervalMs: 10_000 });
    batcher.push(say("once"));

    batcher.stop();
    batcher.stop();

    expect(sent).toHaveLength(1);
  });

  test("reports the last sequence it sent, which is what a reconnect declares", () => {
    const { onFlush } = collect();
    const batcher = createBatcher(onFlush, { intervalMs: 10_000 });

    expect(batcher.lastSeq()).toBe(0);
    batcher.push(say("a"));
    batcher.flush();

    expect(batcher.lastSeq()).toBe(1);
    batcher.stop();
  });
});

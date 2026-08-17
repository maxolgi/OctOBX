import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "../src/awp-task-queue";

// The queue file is a classic script (AudioWorklet-safe: no import/export).
// Importing it in node ESM evaluates the top level, which registers the
// class on globalThis — grab it from there.
const AwpTaskQueue = (globalThis as { AwpTaskQueue: new () => any }).AwpTaskQueue;

describe("AwpTaskQueue", () => {
    beforeEach(() => {
        vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("drains tasks in strict FIFO order", () => {
        const q = new AwpTaskQueue();
        const order: string[] = [];
        q.push(() => order.push("a"));
        q.push(() => order.push("b"));
        q.push(() => order.push("c"));

        const executed = q.drain();

        expect(executed).toBe(3);
        expect(order).toEqual(["a", "b", "c"]);
        expect(q.size).toBe(0);
    });

    it("default drain() budget executes exactly one heavy task per call", () => {
        const q = new AwpTaskQueue();
        const ran: number[] = [];
        q.push(() => ran.push(1), true);
        q.push(() => ran.push(2), true);
        q.push(() => ran.push(3), true);

        expect(q.drain()).toBe(1);
        expect(ran).toEqual([1]);
        expect(q.size).toBe(2);

        expect(q.drain()).toBe(1);
        expect(ran).toEqual([1, 2]);
        expect(q.size).toBe(1);
    });

    it("drain(0) runs leading light tasks and stops at the first heavy task", () => {
        const q = new AwpTaskQueue();
        const order: string[] = [];
        q.push(() => order.push("light-1"));
        q.push(() => order.push("light-2"));
        q.push(() => order.push("heavy"), true);
        q.push(() => order.push("after"));

        const executed = q.drain(0);

        expect(executed).toBe(2);
        expect(order).toEqual(["light-1", "light-2"]);
        expect(q.size).toBe(2);
    });

    it("a light task queued after a heavy task waits when the budget is exhausted (ordering preserved)", () => {
        const q = new AwpTaskQueue();
        const order: string[] = [];
        q.push(() => order.push("engine-recreate"), true);
        q.push(() => order.push("second-heavy"), true);
        q.push(() => order.push("set_param"));

        // First drain: engine-recreate consumes the budget; second-heavy is
        // still pending at the head and BLOCKS the set_param behind it
        // (ordering beats throughput — the param must not bypass a heavy
        // operation queued ahead of it). Once a heavy HAS run, lights behind
        // it drain freely in the same call — the block only exists while the
        // heavy is still pending.
        expect(q.drain()).toBe(1);
        expect(order).toEqual(["engine-recreate"]);
        expect(q.size).toBe(2);

        // Next drain: second-heavy runs and the light set_param follows it.
        expect(q.drain()).toBe(2);
        expect(order).toEqual(["engine-recreate", "second-heavy", "set_param"]);
        expect(q.size).toBe(0);
    });

    it("light tasks before a heavy task all run in the same drain even with budget 1", () => {
        const q = new AwpTaskQueue();
        const order: string[] = [];
        q.push(() => order.push("l1"));
        q.push(() => order.push("l2"));
        q.push(() => order.push("l3"));
        q.push(() => order.push("heavy"), true);

        const executed = q.drain(1);

        expect(executed).toBe(4);
        expect(order).toEqual(["l1", "l2", "l3", "heavy"]);
        expect(q.size).toBe(0);
    });

    it("a throwing task is logged, skipped, and subsequent tasks still run", () => {
        const q = new AwpTaskQueue();
        const order: string[] = [];
        q.push(() => order.push("before"));
        q.push(() => {
            throw new Error("boom");
        });
        q.push(() => order.push("after"));

        const executed = q.drain();

        expect(executed).toBe(3); // the thrower still counts as executed (and was dequeued)
        expect(order).toEqual(["before", "after"]);
        expect(q.size).toBe(0);
        expect(console.error).toHaveBeenCalledTimes(1);
        expect(console.error).toHaveBeenCalledWith(
            "[awp-task-queue] task threw:",
            "boom",
            expect.anything(),
        );
    });

    it("size reflects pending tasks and clear() empties the queue", () => {
        const q = new AwpTaskQueue();
        expect(q.size).toBe(0);

        q.push(() => {}, false);
        q.push(() => {}, true);
        expect(q.size).toBe(2);

        q.clear();
        expect(q.size).toBe(0);

        // After clear(), nothing is left to drain.
        expect(q.drain()).toBe(0);
    });

    it("a task pushing another task during drain runs the new task on the NEXT drain", () => {
        const q = new AwpTaskQueue();
        const order: string[] = [];

        // Chunked-restore pattern: a heavy chunk schedules its heavy
        // successor. The successor must not run within the same drain()
        // call — it was appended after the running task was dequeued, and
        // the exhausted budget parks it until the next quantum.
        const chunk1 = () => {
            order.push("chunk-1");
            q.push(() => order.push("chunk-2"), true);
        };

        q.push(chunk1, true);

        // chunk1 consumed the heavy budget; chunk2 (pushed mid-drain) must
        // not be picked up re-entrantly within this same call.
        const first = q.drain();
        expect(first).toBe(1);
        expect(order).toEqual(["chunk-1"]);
        expect(q.size).toBe(1);

        // Next quantum: chunk2 runs.
        const second = q.drain();
        expect(second).toBe(1);
        expect(order).toEqual(["chunk-1", "chunk-2"]);
        expect(q.size).toBe(0);
    });

    it("push with a non-function argument is ignored", () => {
        const q = new AwpTaskQueue();

        // Malformed postMessage payloads must not poison the queue.
        q.push(undefined as unknown as () => void);
        q.push(null as unknown as () => void);
        q.push(42 as unknown as () => void);
        q.push("set_param" as unknown as () => void);

        expect(q.size).toBe(0);
        expect(q.drain()).toBe(0);
    });
});

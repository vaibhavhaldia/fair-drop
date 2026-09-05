import { describe, it, expect, vi } from "vitest";
import { joinBotWithRetry, runQueueBots, type BotClient } from "../src/runner.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// TC-JOIN-12 (adapted: the retryable-collision contract, exercised against a mock client
// rather than a live join — the live-registration count assertion is Gate 2/IT scope).
describe("TC-JOIN-12 — E_HANDLE_COLLISION is retryable, not fatal", () => {
  it("regenerates the handle suffix and retries until join succeeds", async () => {
    let attempts = 0;
    const client: BotClient = {
      join: vi.fn(async () => {
        attempts += 1;
        if (attempts < 3) {
          const err = new Error("collision") as Error & { code: string };
          err.code = "E_HANDLE_COLLISION";
          throw err;
        }
        return 42n;
      }),
      submitBid: vi.fn(),
    };

    const id = await joinBotWithRetry(client, 1n);
    expect(id).toBe(42n);
    expect(attempts).toBe(3);
  });

  it("swallows every other join error and gives up without throwing", async () => {
    const client: BotClient = {
      join: vi.fn(async () => {
        const err = new Error("settled") as Error & { code: string };
        err.code = "E_EVENT_SETTLED";
        throw err;
      }),
      submitBid: vi.fn(),
    };

    await expect(joinBotWithRetry(client, 1n)).resolves.toBeUndefined();
  });
});

// TC-POOL-03 (adapted: the bot-runner HTTP service and its 1,000-bot OS-process assertion are
// cut per the task file; what remains testable in-process is the structural guarantee — many
// bots complete as concurrent async tasks, never as a per-bot process, and never sequentially).
describe("TC-POOL-03 — bots run as async tasks in one process, not child processes", () => {
  it("imports no child_process / worker_threads module", () => {
    const src = fileURLToPath(new URL("../src/runner.ts", import.meta.url));
    const text = readFileSync(src, "utf8");
    expect(text).not.toMatch(/child_process|worker_threads/);
  });

  it("runs N bots concurrently — total time stays near one delay, not N delays", async () => {
    const client: BotClient = {
      join: vi.fn(async () => 1n),
      submitBid: vi.fn(),
    };

    const start = Date.now();
    await runQueueBots(client, { eventId: 1n, ticketPrice: 15_000, count: 30 });
    const elapsed = Date.now() - start;

    // Sequential would be ~30 * up to 500ms (mean 250ms) = several seconds.
    // Concurrent (Promise.all over async tasks) stays close to the single slowest delay.
    expect(elapsed).toBeLessThan(700);
    expect(client.join).toHaveBeenCalledTimes(30);
    expect(client.submitBid).toHaveBeenCalledTimes(30);
  });

  it("swallows E_INSUFFICIENT_BALANCE as normal traffic, not a failure", async () => {
    const client: BotClient = {
      join: vi.fn(async () => 1n),
      submitBid: vi.fn(() => {
        const err = new Error("no money") as Error & { code: string };
        err.code = "E_INSUFFICIENT_BALANCE";
        throw err;
      }),
    };

    await expect(
      runQueueBots(client, { eventId: 1n, ticketPrice: 15_000, count: 3 })
    ).resolves.toBeUndefined();
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { expect, it, vi } from "vitest";

function setup(itemCount: number, page: (body: any, call: number) => any) {
  let confirmation: { onConfirm: (purge: boolean, done: () => void) => Promise<void> };
  const requests: any[] = [];
  const toast = vi.fn();
  const loaded = vi.fn();
  const refreshed = vi.fn();
  const context = vm.createContext({
    WORKER_URL: "https://example.test", AUTH_TOKEN: "test-token",
    integrationsInfo: [{ provider: "notion", name: "Notion", itemCount }],
    t: (key: string) => key, tPlural: (key: string) => key,
    openDangerConfirm: (options: any) => { confirmation = options; },
    showToast: toast, refreshAll: refreshed,
    fetch: async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      return { ok: true, json: async () => page(body, requests.length) };
    },
  });
  vm.runInContext(readFileSync(resolve(import.meta.dirname, "../../public/js/integrations.js"), "utf8"), context);
  context.__loaded = loaded;
  vm.runInContext("loadIntegrations = globalThis.__loaded", context);
  const button = { disabled: false, textContent: "" };
  (context as any).disconnectIntegration("notion", button);
  const done = vi.fn();
  return { requests, toast, loaded, refreshed, button, done,
    run: () => confirmation!.onConfirm(true, done) };
}

it.each([200, 500])("接続%d件を1件ページで削除し、完了確認までcursorを引き継ぐ", async count => {
  const ui = setup(count, (body, call) => {
    expect(body).toEqual(call === 1 ? { purge: true } : { purge: true, cursor: `k${call - 2}` });
    return call > count ? { ok: true, done: true, purged: count, kept: 0 }
      : { ok: true, done: false, purged: call, skipped: 0, next_cursor: `k${call - 1}` };
  });
  await ui.run();
  expect(ui.requests).toHaveLength(count + 1);
  expect(ui.done).toHaveBeenCalledOnce();
  expect(ui.loaded).toHaveBeenCalledOnce();
  expect(ui.refreshed).toHaveBeenCalledOnce();
  expect(ui.toast).not.toHaveBeenCalled();
});

it("孤児の削除は同じcursorでも累積件数が増えれば完了まで進める", async () => {
  const ui = setup(0, (_body, call) => call === 4
    ? { ok: true, done: true, purged: 3, kept: 0 }
    : { ok: true, done: false, purged: call, skipped: 0, next_cursor: "" });
  await ui.run();
  expect(ui.requests).toHaveLength(4);
  expect(ui.done).toHaveBeenCalledOnce();
  expect(ui.toast).not.toHaveBeenCalled();
});

it("同じcursor・件数で進まない応答は2回で停止し、成功表示しない", async () => {
  const ui = setup(500, () => ({ ok: true, done: false, purged: 1, skipped: 0, next_cursor: "k0" }));
  await ui.run();
  expect(ui.requests).toHaveLength(2);
  expect(ui.done).not.toHaveBeenCalled();
  expect(ui.loaded).not.toHaveBeenCalled();
  expect(ui.button.disabled).toBe(false);
  expect(ui.toast).toHaveBeenCalledOnce();
});

it("cursorを返さない途中応答は停止する", async () => {
  const ui = setup(1, () => ({ ok: true, done: false, purged: 1, skipped: 0 }));
  await ui.run();
  expect(ui.requests).toHaveLength(1);
  expect(ui.done).not.toHaveBeenCalled();
  expect(ui.toast).toHaveBeenCalledOnce();
});

it("進捗が増え続けても既知mapと孤児枠を超えたら停止する", async () => {
  const ui = setup(2, (_body, call) => ({ ok: true, done: false, purged: call, skipped: 0, next_cursor: `${call}` }));
  await ui.run();
  expect(ui.requests).toHaveLength(203);
  expect(ui.done).not.toHaveBeenCalled();
  expect(ui.toast).toHaveBeenCalledOnce();
});

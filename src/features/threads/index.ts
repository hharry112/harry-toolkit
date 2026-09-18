import { App, Notice, Platform, Setting, WorkspaceLeaf } from "obsidian";
import { ThreadsApi } from "./api";
import { SyncRunner } from "./context";
import type { ThreadsContext } from "./context";
import { THREADS_VIEW_TYPE, ThreadsDashboardView } from "./dashboardView";
import { confirmBeforeSync } from "./modals";
import { ThreadsStore } from "./store";
import { syncPosts } from "./sync";
import {
  DEFAULT_SETTINGS,
  PANEL_LOCATION_LABEL,
  PanelLocation,
  ThreadsSettings,
} from "./types";
import type { Feature, FeatureContext } from "../../core/feature";

/** 權杖剩不到這麼多天就試著自動延長（Meta 的長效權杖是 60 天） */
const REFRESH_WHEN_DAYS_LEFT = 10;

/** 插件啟動後隔多久才檢查權杖，避免跟 Obsidian 啟動搶資源 */
const STARTUP_DELAY = 8000;

/** 每隔多久檢查一次權杖到期；Obsidian 一開就是好幾天不關的情況很常見 */
const TOKEN_CHECK_INTERVAL = 6 * 60 * 60 * 1000;

function newPanelLeaf(app: App, location: PanelLocation): WorkspaceLeaf | null {
  switch (location) {
    case "right":
      return app.workspace.getRightLeaf(false);
    case "left":
      return app.workspace.getLeftLeaf(false);
    case "window":
      // 獨立視窗是電腦版限定，手機版退回一般分頁
      return app.workspace.getLeaf(Platform.isDesktopApp ? "window" : "tab");
    default:
      return app.workspace.getLeaf("tab");
  }
}

/**
 * 開啟面板。已經開著就只顯示出來，**不搬動它的位置** ——
 * 使用者把它拖到哪裡是他的配置（與月曆同一套規矩）。
 */
async function activatePanel(app: App, settings: ThreadsSettings): Promise<void> {
  const existing = app.workspace.getLeavesOfType(THREADS_VIEW_TYPE);
  if (existing.length > 0) {
    app.workspace.revealLeaf(existing[0]);
    return;
  }
  const leaf = newPanelLeaf(app, settings.panelLocation);
  if (!leaf) {
    new Notice("無法開啟 Threads 面板，請改用「面板開啟位置」設定選別的位置。");
    return;
  }
  await leaf.setViewState({ type: THREADS_VIEW_TYPE, active: true });
  app.workspace.revealLeaf(leaf);
}

/** 讓開著的面板重新讀檔重繪 */
async function refreshPanels(app: App): Promise<void> {
  for (const leaf of app.workspace.getLeavesOfType(THREADS_VIEW_TYPE)) {
    const view = leaf.view;
    if (view instanceof ThreadsDashboardView) await view.reload();
  }
}

/** 權杖快到期就試著延長；Meta 規定要建立滿 24 小時才能刷新，失敗是正常的 */
async function maybeRefreshToken(ctx: ThreadsContext): Promise<void> {
  const settings = ctx.settings;
  if (!settings.tokenExpiresAt) return;
  const left = new Date(settings.tokenExpiresAt).getTime() - Date.now();
  if (Number.isNaN(left) || left > REFRESH_WHEN_DAYS_LEFT * 86400000) return;

  const api = ctx.api();
  if (!api) return;
  try {
    const refreshed = await api.refreshToken();
    settings.accessToken = refreshed.token;
    settings.tokenExpiresAt = refreshed.expiresAt;
    await ctx.save();
    new Notice("Threads 權杖已自動延長 60 天。");
  } catch (e) {
    console.warn("[harry-toolkit] Threads 權杖刷新失敗", e);
  }
}

export const threadsFeature: Feature<ThreadsSettings> = {
  id: "threads",
  name: "Threads 數據",
  description:
    "用官方 API 抓自己帳號的貼文成效，做成可依瀏覽、讚、回覆等指標排序的排行榜面板，" +
    "也可以搜尋貼文內容。只讀取，不發文。",
  defaults: DEFAULT_SETTINGS,

  onload(fctx: FeatureContext<ThreadsSettings>) {
    const app = fctx.app;
    const plugin = fctx.plugin;
    const store = new ThreadsStore(app, () => fctx.settings.dataFolder);
    const runner = new SyncRunner();

    const ctx: ThreadsContext = {
      app,
      settings: fctx.settings,
      save: () => fctx.save(),
      store,
      api: () => (fctx.settings.accessToken ? new ThreadsApi(fctx.settings.accessToken) : null),
      runner,
    };

    plugin.registerView(THREADS_VIEW_TYPE, (leaf) => new ThreadsDashboardView(leaf, ctx));

    plugin.addRibbonIcon("bar-chart-3", "Threads 數據", () => activatePanel(app, fctx.settings));

    plugin.addCommand({
      id: "threads-open-panel",
      name: "開啟 Threads 數據面板",
      callback: () => activatePanel(app, fctx.settings),
    });

    plugin.addCommand({
      id: "threads-sync-recent",
      name: "Threads：更新最近貼文成效",
      callback: () => runSyncCommand(ctx, "recent"),
    });

    plugin.addCommand({
      id: "threads-sync-all",
      name: "Threads：全部重抓（會跑比較久）",
      callback: () => runSyncCommand(ctx, "all"),
    });

    // 權杖是 60 天長效的，**過期就要人工回 Meta 後台重新產生**，所以自動延長
    // 一定要有人定期觸發。以前它搭在每日記錄流程上，那個流程拿掉之後改成自己排程：
    // 啟動後隔一段時間檢查一次（不跟 Obsidian 的啟動搶資源），之後每 6 小時再看一次，
    // Obsidian 連開好幾天也不會錯過到期前的那段時間。
    const startup = window.setTimeout(() => {
      void maybeRefreshToken(ctx);
    }, STARTUP_DELAY);
    plugin.register(() => window.clearTimeout(startup));
    plugin.registerInterval(
      window.setInterval(() => {
        void maybeRefreshToken(ctx);
      }, TOKEN_CHECK_INTERVAL)
    );
  },

  buildSettings(containerEl: HTMLElement, ctx: FeatureContext<ThreadsSettings>) {
    const store = new ThreadsStore(ctx.app, () => ctx.settings.dataFolder);

    const status = containerEl.createDiv({ cls: "ht-threads-setting-status" });
    const renderStatus = () => {
      status.empty();
      if (!ctx.settings.userId) {
        status.createSpan({ text: "尚未連線。" });
        return;
      }
      const parts = [`已連線：@${ctx.settings.username}`];
      if (ctx.settings.tokenExpiresAt) {
        const left = Math.round(
          (new Date(ctx.settings.tokenExpiresAt).getTime() - Date.now()) / 86400000
        );
        parts.push(Number.isNaN(left) ? "" : `權杖約 ${left} 天後到期`);
      }
      status.createSpan({ text: parts.filter(Boolean).join("　·　") });
    };
    renderStatus();

    new Setting(containerEl)
      .setName("存取權杖")
      .setDesc(
        "到 Meta 開發者後台的「用戶權杖產生器」產生 Threads User Access Token，" +
          "權限要勾 threads_basic 與 threads_manage_insights。" +
          "注意：權杖會以明文存在 vault 的 .obsidian 設定檔裡，若你的 vault 有同步或上傳 Git，它會跟著出去。"
      )
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.addClass("ht-wide-input");
        text
          .setPlaceholder("貼上權杖")
          .setValue(ctx.settings.accessToken)
          .onChange(async (value) => {
            ctx.settings.accessToken = value.trim();
            await ctx.save();
          });
      })
      // 權杖是一長串亂碼，說明又有三行；不放成獨立一行的話輸入框只剩一小格
      .then((setting) => setting.settingEl.addClass("ht-setting-stacked"));

    new Setting(containerEl)
      .setName("測試連線")
      .setDesc("確認權杖可用，並記下帳號 id（之後所有查詢都要用）。")
      .addButton((btn) =>
        btn
          .setButtonText("測試連線")
          .setCta()
          .onClick(async () => {
            if (!ctx.settings.accessToken) {
              new Notice("請先貼上權杖。");
              return;
            }
            btn.setDisabled(true);
            try {
              const api = new ThreadsApi(ctx.settings.accessToken);
              const profile = await api.getProfile();
              ctx.settings.userId = profile.id;
              ctx.settings.username = profile.username;
              // 順便確認 insights 權限有沒有給，不然要等到抓取才發現
              const followers = await api.getFollowersCount(profile.id);
              await ctx.save();
              renderStatus();
              new Notice(
                `連線成功：@${profile.username}` +
                  (followers === null ? "" : `，目前追蹤人數 ${followers.toLocaleString("zh-TW")}`)
              );
            } catch (e) {
              new Notice(`連線失敗：${(e as Error).message}`, 10000);
            } finally {
              btn.setDisabled(false);
            }
          })
      );

    new Setting(containerEl)
      .setName("資料資料夾")
      .setDesc(
        `抓回來的數據存成 JSON 放在這個資料夾（vault 相對路徑，留空 = vault 根目錄）。` +
          `目前是 ${store.postsPath}。移除插件後檔案仍會留著。`
      )
      .addText((text) => {
        text.inputEl.addClass("ht-wide-input");
        text
          .setPlaceholder("Threads 數據")
          .setValue(ctx.settings.dataFolder)
          .onChange(async (value) => {
            ctx.settings.dataFolder = value.trim();
            await ctx.save();
          });
      })
      // 跟權杖那一項同寬，兩個輸入框並排看起來才整齊
      .then((setting) => setting.settingEl.addClass("ht-setting-stacked"));

    new Setting(containerEl)
      .setName("「更新最近貼文」的天數")
      .setDesc("日常更新只處理這段期間內發佈的貼文。貼文成效必須一篇一篇問，篇數越多跑越久。")
      .addSlider((slider) =>
        slider
          .setLimits(7, 180, 1)
          .setValue(ctx.settings.recentDays)
          .setDynamicTooltip()
          .onChange(async (value) => {
            ctx.settings.recentDays = value;
            await ctx.save();
          })
      );

    new Setting(containerEl)
      .setName("一併抓取我的回覆")
      .setDesc(
        "回覆在另一支 API（me/replies），要另外抓，而且權杖產生時必須多勾 threads_read_replies 權限。" +
          "回覆通常比主貼文多很多，開啟後抓取時間會明顯變長。關閉時面板的「含回覆」不會有東西可看。"
      )
      .addToggle((toggle) =>
        toggle.setValue(ctx.settings.fetchReplies).onChange(async (value) => {
          ctx.settings.fetchReplies = value;
          await ctx.save();
        })
      );

    new Setting(containerEl)
      .setName("面板開啟位置")
      .setDesc("只在面板還沒開啟、要新開一個時才用得到；已經開著的面板不會被搬動。")
      .addDropdown((dd) => {
        for (const [value, label] of Object.entries(PANEL_LOCATION_LABEL)) {
          dd.addOption(value, label);
        }
        dd.setValue(ctx.settings.panelLocation).onChange(async (value) => {
          ctx.settings.panelLocation = value as PanelLocation;
          await ctx.save();
        });
      });
  },
};

/** 指令版的抓取：跟面板上的按鈕做同一件事，進度用 Notice 呈現 */
async function runSyncCommand(ctx: ThreadsContext, mode: "recent" | "all"): Promise<void> {
  const api = ctx.api();
  if (!api) {
    new Notice("尚未設定 Threads 權杖。");
    return;
  }
  if (ctx.runner.isRunning) {
    new Notice("已經有一項抓取在進行中。");
    return;
  }
  if (!(await confirmBeforeSync(ctx, mode))) return;
  new Notice(mode === "all" ? "開始全部重抓，這會跑一陣子…" : "開始更新最近貼文…");

  let outcome: { ok: boolean; result?: Awaited<ReturnType<typeof syncPosts>> };
  try {
    outcome = await ctx.runner.run((handle) =>
      syncPosts(api, ctx.store, ctx.settings, mode, handle)
    );
  } catch (e) {
    new Notice(`Threads 抓取失敗：${(e as Error).message}`, 12000);
    return;
  }

  if (!outcome.ok || !outcome.result) return;
  ctx.settings.lastSyncAt = new Date().toISOString();
  await ctx.save();
  const r = outcome.result;
  const parts = [`共 ${r.fetched} 篇`, `成效更新 ${r.updated} 篇`];
  if (r.failed > 0) parts.push(`失敗 ${r.failed} 篇`);
  if (r.cancelled) parts.push("（已中止）");
  new Notice(`Threads 更新完成：${parts.join("，")}`);
  if (r.replyError) new Notice(`回覆沒抓到：${r.replyError}`, 12000);
  // 開著的面板由 runner 的結束通知自己重讀，這裡不必再叫一次
}

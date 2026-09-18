import { ItemView, Notice, WorkspaceLeaf, setIcon, setTooltip } from "obsidian";
import type { ThreadsContext } from "./context";
import { confirmBeforeSync } from "./modals";
import { metricOf, syncPosts } from "./sync";
import {
  PostRecord,
  PostsFile,
  SORT_LABEL,
  SortKey,
  emptyPostsFile,
  formatCount,
  formatPostTime,
  previewText,
} from "./types";

export const THREADS_VIEW_TYPE = "harry-toolkit-threads";

/** 清單一次顯示幾篇，按「顯示更多」再加同樣的量 */
const PAGE_SIZE = 50;

/**
 * Threads 數據面板。
 *
 * 畫面分成幾塊各自重繪，不要動不動就整個 render()：
 * 抓取進度每篇貼文更新一次（約每 0.2 秒），整頁重畫會閃爍；
 * 而搜尋框一旦被重建，使用者打到一半的字和焦點就沒了（月曆的檔案瀏覽踩過這個雷）。
 */
export class ThreadsDashboardView extends ItemView {
  private posts: PostsFile = emptyPostsFile();
  /** 讀檔失敗時的訊息（例如 JSON 壞掉），顯示在畫面上而不是默默當成空的 */
  private loadError: string | null = null;
  private query = "";
  private limit = PAGE_SIZE;
  private unsubscribe: (() => void) | null = null;

  private headerEl!: HTMLElement;
  private progressEl!: HTMLElement;
  private listEl!: HTMLElement;
  private syncBtn!: HTMLButtonElement;
  private allBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;

  constructor(leaf: WorkspaceLeaf, private ctx: ThreadsContext) {
    super(leaf);
  }

  getViewType() {
    return THREADS_VIEW_TYPE;
  }

  getDisplayText() {
    return "Threads 數據";
  }

  getIcon() {
    return "bar-chart-3";
  }

  async onOpen() {
    this.buildSkeleton();
    // 抓取跑在功能層的 SyncRunner 上，不屬於這個檢視：關掉分頁不會中斷抓取，
    // 重新打開的面板也會接上同一份進度。收到 null 代表整輪結束（成功、失敗或中止都算），
    // 這時重讀檔案 —— 抓取期間被關掉又打開的面板，要靠這裡才會看到新資料。
    this.unsubscribe = this.ctx.runner.subscribe((p) => {
      if (p === null) void this.reload();
      else this.renderProgress();
    });
    await this.reload();
  }

  async onClose() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** 重新讀檔並整頁重繪（抓取結束、或使用者按重新整理時用） */
  async reload(): Promise<void> {
    this.loadError = null;
    try {
      this.posts = await this.ctx.store.loadPosts();
    } catch (e) {
      this.loadError = (e as Error).message;
      this.posts = emptyPostsFile();
    }
    this.renderAll();
  }

  private renderAll() {
    this.renderHeader();
    this.renderProgress();
    this.renderList();
  }

  // ---------- 骨架 ----------

  /** 固定的容器只建一次；之後各區塊各自重繪自己的內容 */
  private buildSkeleton() {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("ht-threads");

    this.headerEl = root.createDiv({ cls: "ht-threads-header" });
    this.progressEl = root.createDiv({ cls: "ht-threads-progress" });
    // 抓取按鈕與搜尋、排序共用一列：面板高度要留給貼文清單
    const actions = root.createDiv({ cls: "ht-threads-actions" });
    this.buildToolbar(actions);
    this.buildFilter(actions);
    this.listEl = root.createDiv({ cls: "ht-threads-list" });
  }

  /** 抓取相關的按鈕。與 buildFilter 共用同一個容器，排成一列 */
  private buildToolbar(bar: HTMLElement) {
    this.syncBtn = bar.createEl("button", { text: "更新最近貼文" });
    this.syncBtn.addEventListener("click", () => this.runSync("recent"));

    this.allBtn = bar.createEl("button", { text: "全部重抓" });
    this.allBtn.addEventListener("click", () => this.runSync("all"));

    this.stopBtn = bar.createEl("button", { text: "停止", cls: "mod-warning" });
    this.stopBtn.addEventListener("click", () => {
      this.ctx.runner.cancel();
      new Notice("已要求停止，正在收尾…");
    });
    this.stopBtn.hide();

    const refresh = bar.createEl("button", { cls: "ht-threads-icon-btn" });
    setIcon(refresh, "refresh-cw");
    refresh.setAttr("aria-label", "重新讀取資料檔");
    refresh.addEventListener("click", () => this.reload());
  }

  /** 搜尋、排序與「含回覆」。接在抓取按鈕後面，同一列 */
  private buildFilter(bar: HTMLElement) {
    const search = bar.createEl("input", {
      type: "text",
      placeholder: "搜尋貼文內容…",
      cls: "ht-threads-search",
    });
    search.value = this.query;
    // 只重畫清單，不重建這個輸入框，否則打字打到一半焦點會掉
    search.addEventListener("input", () => {
      this.query = search.value;
      this.limit = PAGE_SIZE;
      this.renderList();
    });

    const sort = bar.createEl("select", { cls: "dropdown" });
    for (const key of Object.keys(SORT_LABEL) as SortKey[]) {
      sort.createEl("option", { value: key, text: `依${SORT_LABEL[key]}排序` });
    }
    sort.value = this.ctx.settings.sortKey;
    // 先重畫再存檔：存檔寫的是 data.json，vault 放在同步資料夾（雲端硬碟）時
    // 要等好幾秒，等它回來才換清單會讓下拉選單像沒反應
    sort.addEventListener("change", () => {
      this.ctx.settings.sortKey = sort.value as SortKey;
      this.limit = PAGE_SIZE;
      this.renderList();
      void this.ctx.save();
    });

    const label = bar.createEl("label", { cls: "ht-threads-check" });
    const check = label.createEl("input", { type: "checkbox" });
    check.checked = this.ctx.settings.includeReplies;
    label.createSpan({ text: "含回覆" });
    check.addEventListener("change", () => {
      this.ctx.settings.includeReplies = check.checked;
      this.limit = PAGE_SIZE;
      this.renderList();
      void this.ctx.save();
    });
  }

  // ---------- 各區塊 ----------

  private renderHeader() {
    const el = this.headerEl;
    el.empty();

    const settings = this.ctx.settings;
    if (!settings.accessToken || !settings.userId) {
      el.createDiv({
        cls: "ht-threads-empty",
        text: "尚未連線。請到「設定 → Harry Toolkit → Threads 數據」貼上權杖並按「測試連線」。",
      });
      return;
    }

    const title = el.createDiv({ cls: "ht-threads-account" });
    title.createSpan({ cls: "ht-threads-username", text: `@${settings.username}` });

    // 追蹤人數不顯示在這裡：Meta 的 followers_count 更新得又慢又不準，
    // 擺在面板最上面只會誤導。數字仍然每天記進 account-daily.json（補不回來）。

    // 貼文與回覆分開數：兩者抓取成本差很多（回覆通常多好幾倍），
    // 合成一個總數看不出手上到底有多少主貼文
    const replies = this.posts.posts.reduce((n, p) => n + (p.isReply ? 1 : 0), 0);
    const parts: string[] = [
      `${formatCount(this.posts.posts.length - replies)} 篇貼文`,
      `${formatCount(replies)} 則回覆`,
    ];
    if (this.posts.updatedAt) {
      parts.push(`最後更新 ${new Date(this.posts.updatedAt).toLocaleString("zh-TW")}`);
    }
    el.createDiv({ cls: "ht-threads-sub", text: parts.join("　·　") });

    if (this.loadError) {
      el.createDiv({ cls: "ht-threads-error", text: this.loadError });
    }
  }

  private renderProgress() {
    const el = this.progressEl;
    el.empty();
    const running = this.ctx.runner.isRunning;

    this.syncBtn.disabled = running;
    this.allBtn.disabled = running;
    if (running) this.stopBtn.show();
    else this.stopBtn.hide();

    const p = this.ctx.runner.progress;
    if (!running || !p) {
      el.hide();
      return;
    }
    el.show();
    const text =
      p.total && p.current
        ? `${p.message}（${p.current} / ${p.total}）`
        : p.message;
    el.createDiv({ cls: "ht-threads-progress-text", text });
    if (p.total && p.current) {
      const bar = el.createDiv({ cls: "ht-threads-bar" });
      const fill = bar.createDiv({ cls: "ht-threads-bar-fill" });
      fill.style.width = `${Math.round((p.current / p.total) * 100)}%`;
    }
  }

  private visiblePosts(): PostRecord[] {
    const key = this.ctx.settings.sortKey;
    const q = this.query.trim().toLowerCase();
    return this.posts.posts
      .filter((p) => this.ctx.settings.includeReplies || !p.isReply)
      .filter((p) => !q || p.text.toLowerCase().includes(q))
      .sort((a, b) => metricOf(b, key) - metricOf(a, key));
  }

  private renderList() {
    const el = this.listEl;
    el.empty();

    if (!this.ctx.settings.accessToken) return;

    // 勾了「含回覆」卻一則回覆都沒有：多半是還沒開啟抓取回覆，講清楚而不是讓人以為壞了
    if (this.ctx.settings.includeReplies && !this.posts.posts.some((p) => p.isReply)) {
      this.listEl.createDiv({
        cls: "ht-threads-hint ht-threads-notice",
        text: this.ctx.settings.fetchReplies
          ? "資料裡還沒有回覆。回覆要重新抓一次才會進來（設定裡的「一併抓取我的回覆」已開啟）。"
          : "資料裡沒有回覆。回覆在另一支 API，要先到「設定 → Threads 數據」開啟「一併抓取我的回覆」再抓一次；權杖也必須有 threads_read_replies 權限。",
      });
    }

    const all = this.visiblePosts();
    if (all.length === 0) {
      el.createDiv({
        cls: "ht-threads-empty",
        text: this.posts.posts.length === 0
          ? "還沒有資料。按上方的「更新最近貼文」抓一次。"
          : "沒有符合條件的貼文。",
      });
      return;
    }

    for (const post of all.slice(0, this.limit)) {
      this.renderRow(el, post);
    }

    if (all.length > this.limit) {
      const more = el.createEl("button", {
        cls: "ht-threads-more",
        text: `顯示更多（還有 ${all.length - this.limit} 篇）`,
      });
      more.addEventListener("click", () => {
        this.limit += PAGE_SIZE;
        this.renderList();
      });
    }
  }

  private renderRow(parent: HTMLElement, post: PostRecord) {
    const row = parent.createDiv({ cls: "ht-threads-row" });
    if (post.permalink) {
      row.addClass("ht-threads-clickable");
      row.addEventListener("click", () => window.open(post.permalink, "_blank"));
    }

    const main = row.createDiv({ cls: "ht-threads-row-main" });
    // 清單上夾成兩行（CSS），滑鼠移上去用 Obsidian 的提示框看完整內容
    const text = previewText(post.text);
    setTooltip(main.createDiv({ cls: "ht-threads-text", text }), text);

    const meta = main.createDiv({ cls: "ht-threads-meta" });
    meta.createSpan({ text: formatPostTime(post.timestamp) });
    if (post.isReply) meta.createSpan({ cls: "ht-threads-tag", text: "回覆" });
    if (post.isQuotePost) meta.createSpan({ cls: "ht-threads-tag", text: "引用" });
    if (!post.metricsAt) meta.createSpan({ cls: "ht-threads-tag", text: "未取得成效" });

    const stats = row.createDiv({ cls: "ht-threads-stats" });
    // 六格要跟排序選單的六個指標一致，否則依引用或分享排序時看不到自己排的是什麼
    const cells: [SortKey, number | null][] = [
      ["views", post.metrics.views],
      ["likes", post.metrics.likes],
      ["replies", post.metrics.replies],
      ["reposts", post.metrics.reposts],
      ["quotes", post.metrics.quotes],
      ["shares", post.metrics.shares],
    ];
    for (const [key, value] of cells) {
      const label = SORT_LABEL[key];
      const cell = stats.createDiv({ cls: "ht-threads-stat" });
      // 目前排序依據的那一格標出來，一排數字裡才知道自己在看哪一個
      if (key === this.ctx.settings.sortKey) cell.addClass("ht-threads-stat-active");
      // 回覆類型的貼文，Meta 一律回傳 replies=0（實測 4453 則無一例外，連幾千個讚的
      // 熱門回覆也是 0），那是「沒有這項資料」而不是「真的沒人回」。顯示 0 會誤導。
      const unavailable = key === "replies" && post.isReply;
      const cellValue = cell.createDiv({
        cls: "ht-threads-stat-value",
        text: unavailable ? "—" : formatCount(value),
      });
      if (unavailable) {
        cellValue.addClass("ht-threads-stat-na");
        cellValue.setAttr("aria-label", "Threads API 不提供回覆本身的回覆數");
      }
      cell.createDiv({ cls: "ht-threads-stat-label", text: label });
    }
  }

  // ---------- 動作 ----------

  private async runSync(mode: "recent" | "all") {
    const api = this.ctx.api();
    if (!api) {
      new Notice("尚未設定 Threads 權杖。");
      return;
    }
    if (this.ctx.runner.isRunning) {
      new Notice("已經有一項抓取在進行中。");
      return;
    }
    if (!(await confirmBeforeSync(this.ctx, mode))) return;

    // 整輪失敗（權杖過期、斷網、資料檔壞掉）一定要讓使用者看到原因，
    // 沒接住的話畫面上什麼都不會發生，只會像是按鈕沒反應
    let outcome: { ok: boolean; result?: Awaited<ReturnType<typeof syncPosts>> };
    try {
      outcome = await this.ctx.runner.run((handle) =>
        syncPosts(api, this.ctx.store, this.ctx.settings, mode, handle)
      );
    } catch (e) {
      new Notice(`Threads 抓取失敗：${(e as Error).message}`, 12000);
      return;
    }

    if (!outcome.ok) {
      new Notice("已經有一項抓取在進行中。");
      return;
    }
    const r = outcome.result;
    if (r) {
      this.ctx.settings.lastSyncAt = new Date().toISOString();
      await this.ctx.save();
      const parts = [`共 ${r.fetched} 篇`, `成效更新 ${r.updated} 篇`];
      if (r.failed > 0) parts.push(`失敗 ${r.failed} 篇`);
      if (r.cancelled) parts.push("（已中止，抓到的部分已存檔）");
      new Notice(`Threads 更新完成：${parts.join("，")}`);
      if (r.replyError) new Notice(`回覆沒抓到：${r.replyError}`, 12000);
    }
    // 不在這裡 reload：整輪結束時 runner 會通知每一個開著的面板自己重讀，
    // 這個檢視可能早就被關掉了（關分頁不會中斷抓取）
  }
}

import { ItemView, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
// 只取型別（編譯後消失）；執行時用 Obsidian 掛在 window.moment 的內建 moment。
// 千萬不要 import moment from "moment"：Obsidian 不會替插件提供該模組，載入會直接失敗。
import type { Moment } from "moment";

const wmoment = window.moment as unknown as (input?: string, format?: string) => Moment;
import {
  appHasDailyNotesPluginLoaded,
  createDailyNote,
  getAllDailyNotes,
  getDailyNote,
} from "obsidian-daily-notes-interface";
import type { SchedulerContext } from "./context";
import { scanArticles, setArticleSchedule } from "./articles";
import { FileBrowser, SCHEDULED_KEY } from "./fileBrowser";
import type { FileBrowserCustomView } from "./fileBrowser";
import { AddTodoModal } from "./modals";
import { Article, TodoItem, formatDate, todayStr } from "./types";

export const CALENDAR_VIEW_TYPE = "writer-scheduler-calendar";

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

/** 拖曳中的項目，存在檢視實例上（跨月翻頁重繪後仍有效） */
type DragPayload = { kind: "article"; file: TFile } | { kind: "todo"; item: TodoItem };

/** 已排定事項的一列：已排程文章或有到期日的未完成待辦 */
type ScheduledEntry = { date: string } & (
  | { kind: "article"; article: Article }
  | { kind: "todo"; todo: TodoItem }
);

/**
 * 發佈月曆（插件主畫面）：
 * - 點日期格子空白處 → 新增該天到期的待辦；滑到空白處會列出當天所有事項
 * - 已排程文章與未完成待辦可拖曳到別天改期
 * - 拖曳中懸停在上／下月箭頭約半秒會自動翻頁
 * - 底部依序為「未排定待辦」「已排定事項」「檔案瀏覽」三個收合區；
 *   未排定待辦可拖進日期指定到期日，已排定事項是所有排程的總覽（不分月份）
 * - 「檔案瀏覽」左欄樹最上面有三列虛擬清單：釘選筆記、草稿、已排定事項。
 *   草稿只剩這一個入口（底部的獨立草稿區 2026-09-19 拿掉了）；
 *   已排定事項兩邊都有，底部看整體、檔案瀏覽看細項
 * - 待辦項目有鉛筆按鈕，可原地編輯內容（Enter 儲存、Esc 取消），不用開 Todo 檔
 */
export class CalendarView extends ItemView {
  private year: number;
  private month: number; // 0-based
  private dragPayload: DragPayload | null = null;
  private flipTimer: number | null = null;
  private refreshTimer: number | null = null;
  /** 「未排定待辦」收合區的展開狀態，跨重繪保留，預設展開 */
  private unscheduledOpen = true;
  /** 「已排定事項」收合區的展開狀態，跨重繪保留，預設展開 */
  private scheduledOpen = true;
  /** 是否正在原地編輯待辦（編輯中不自動重繪，避免毀掉輸入框） */
  private editingTodo = false;
  /** 底部的檔案瀏覽區；狀態存在這個實例上，跨重繪保留 */
  private fileBrowser: FileBrowser;
  /**
   * 最近一次重繪掃到的文章與待辦。
   *
   * 檔案瀏覽的「已排定事項」由這裡取值：那一區會因為翻資料夾、改排序被單獨重畫，
   * 而待辦要非同步讀檔，不可能在那個時間點現場撈。資料真的變動時月曆本來就會整個重繪，
   * 順手把這份快照換掉。
   */
  private snapshot: { articles: Article[]; todos: TodoItem[] } = { articles: [], todos: [] };

  constructor(leaf: WorkspaceLeaf, private ctx: SchedulerContext) {
    super(leaf);
    const now = new Date();
    this.year = now.getFullYear();
    this.month = now.getMonth();
    this.fileBrowser = new FileBrowser({
      app: ctx.app,
      settings: ctx.settings,
      save: () => ctx.save(),
      // 檔案瀏覽裡的 md 檔共用月曆這一份拖曳狀態，拖進日期格子就會排程
      makeDraggable: (el, file) => this.makeDraggable(el, { kind: "article", file }),
      customViews: () => this.browserViews(),
    });
  }

  getViewType() {
    return CALENDAR_VIEW_TYPE;
  }

  getDisplayText() {
    return "發佈月曆";
  }

  getIcon() {
    return "calendar-days";
  }

  async onOpen() {
    await this.render();
    // 筆記 frontmatter 或 Todo 檔變動時重繪（拖曳中不重繪，避免打斷拖放）
    this.registerEvent(this.app.metadataCache.on("changed", () => this.scheduleRender()));
    this.registerEvent(this.app.vault.on("delete", () => this.scheduleRender()));
    this.registerEvent(this.app.vault.on("rename", () => this.scheduleRender()));
    // create 是為了底部的檔案瀏覽：新增檔案後清單要跟著出現。
    // Obsidian 剛啟動時會對既有檔案連續丟出 create，靠 scheduleRender 的 300ms 併成一次重繪。
    this.registerEvent(this.app.vault.on("create", () => this.scheduleRender()));
  }

  private scheduleRender() {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      if (this.dragPayload === null && !this.editingTodo) this.render();
    }, 300);
  }

  private shiftMonth(delta: number) {
    this.month += delta;
    while (this.month < 0) {
      this.month += 12;
      this.year--;
    }
    while (this.month > 11) {
      this.month -= 12;
      this.year++;
    }
    this.render();
  }

  async render() {
    const container = this.contentEl;
    container.empty();
    container.addClass("ws-calendar");

    // ===== 導覽列 =====
    const nav = container.createDiv({ cls: "ws-cal-nav" });
    const prev = nav.createEl("span", { cls: "ws-icon-btn", attr: { "aria-label": "上個月" } });
    setIcon(prev, "chevron-left");
    nav.createEl("span", { cls: "ws-cal-title", text: `${this.year} 年 ${this.month + 1} 月` });
    const next = nav.createEl("span", { cls: "ws-icon-btn", attr: { "aria-label": "下個月" } });
    setIcon(next, "chevron-right");
    nav.createEl("span", {
      cls: "ws-cal-hint",
      text: "點日期數字開啟日記；點日期格子新增待辦",
    });
    const todayBtn = nav.createEl("button", { text: "今天", cls: "ws-cal-today-btn" });

    prev.onclick = () => this.shiftMonth(-1);
    next.onclick = () => this.shiftMonth(1);
    todayBtn.onclick = () => {
      const now = new Date();
      this.year = now.getFullYear();
      this.month = now.getMonth();
      this.render();
    };
    // 拖曳中懸停箭頭 → 翻頁（dragPayload 存在實例上，重繪後拖曳仍可繼續）
    this.armFlipOnDrag(prev, -1);
    this.armFlipOnDrag(next, 1);

    // 拖曳結束（無論是否成功放下）都清除狀態
    container.addEventListener("dragend", () => {
      this.dragPayload = null;
    });

    // ===== 整理事件：日期 -> 項目 =====
    const articles = scanArticles(this.app, this.ctx.settings);
    const todos = await this.ctx.todoStore.list();
    // 檔案瀏覽的「已排定事項」在它自己重畫時要拿得到這份資料
    this.snapshot = { articles, todos };

    const push = <T>(m: Map<string, T[]>, k: string, v: T) => {
      const arr = m.get(k);
      if (arr) arr.push(v);
      else m.set(k, [v]);
    };
    const scheduledByDate = new Map<string, typeof articles>();
    const publishedByDate = new Map<string, typeof articles>();
    const todosByDate = new Map<string, TodoItem[]>();
    for (const a of articles) {
      if (a.status === "scheduled" && a.publishDate) push(scheduledByDate, a.publishDate, a);
      else if (a.status === "published" && a.publishedDate) push(publishedByDate, a.publishedDate, a);
    }
    for (const t of todos) {
      if (!t.done && t.dueDate) push(todosByDate, t.dueDate, t);
    }

    // ===== 月曆格線（週一開頭） =====
    const grid = container.createDiv({ cls: "ws-cal-grid" });
    for (const w of WEEKDAYS) grid.createDiv({ cls: "ws-cal-weekday", text: w });

    const first = new Date(this.year, this.month, 1);
    const startOffset = first.getDay(); // 週日開頭
    const daysInMonth = new Date(this.year, this.month + 1, 0).getDate();
    const today = todayStr();

    for (let i = 0; i < startOffset; i++) grid.createDiv({ cls: "ws-cal-cell ws-cal-empty" });

    // 每日筆記整合：一次撈出全部每日筆記，逐日比對是否存在
    // （核心外掛未啟用或資料夾不存在時 getAllDailyNotes 會丟例外，視為沒有筆記）
    let dailyNotes: Record<string, TFile> = {};
    try {
      if (appHasDailyNotesPluginLoaded()) dailyNotes = getAllDailyNotes();
    } catch (e) {
      dailyNotes = {};
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = formatDate(new Date(this.year, this.month, day));
      const cell = grid.createDiv({ cls: "ws-cal-cell" });
      if (dateStr === today) cell.addClass("ws-cal-today");

      // 日期數字＝每日筆記按鈕：點擊開啟（不存在就建立），有筆記的日子帶小圓點
      const hasDaily = !!getDailyNote(wmoment(dateStr, "YYYY-MM-DD"), dailyNotes);
      const daynum = cell.createDiv({
        cls: `ws-cal-daynum ws-daynum-btn${hasDaily ? " ws-has-daily" : ""}`,
        attr: {
          "aria-label": hasDaily ? "開啟每日筆記" : "建立並開啟每日筆記",
          // 空的 title 會中斷繼承：不設的話，格子那份當日清單會跟這顆按鈕自己的提示疊在一起
          title: "",
        },
      });
      daynum.createSpan({ text: String(day) });
      if (hasDaily) daynum.createSpan({ cls: "ws-daily-dot" });
      daynum.onclick = (e) => {
        e.stopPropagation();
        this.openDailyNote(dateStr, dailyNotes);
      };

      const scheduled = scheduledByDate.get(dateStr) ?? [];
      const published = publishedByDate.get(dateStr) ?? [];
      const dayTodos = todosByDate.get(dateStr) ?? [];
      const overdue = dateStr < today;
      for (const a of scheduled) this.renderArticle(cell, a, dateStr);
      for (const a of published) this.renderArticle(cell, a, dateStr);
      for (const t of dayTodos) this.renderTodo(cell, t, overdue);

      // 格子很窄，標題一定會被截掉，事項多的日子還會被格子高度擠掉。
      // 滑到格子空白處就用原生提示列出當天全部事項（事項本身各有自己的 title，不會被蓋掉）。
      const lines = [
        ...scheduled.map((a) => `預定發佈：${a.file.basename}${overdue ? "（逾期）" : ""}`),
        ...published.map((a) => `已發佈：${a.file.basename}`),
        ...dayTodos.map((t) => `待辦：${t.text}${overdue ? "（逾期）" : ""}`),
      ];
      if (lines.length > 0) {
        const head = `${this.month + 1} 月 ${day} 日 · ${lines.length} 件`;
        cell.setAttr("title", [head, ...lines].join("\n"));
      }

      // 點空白處新增當天待辦
      cell.onclick = () => {
        new AddTodoModal(
          this.app,
          async (text, due) => {
            await this.ctx.todoStore.add(text, due);
            this.render();
          },
          dateStr
        ).open();
      };

      this.makeDropTarget(cell, dateStr);
    }

    // ===== 未排定待辦（沒有到期日的未完成項目） =====
    // 排在已排定事項上面：這一區是「還沒決定哪天做」的收件匣，
    // 要先看到它才會想把東西拖進月曆（使用者 2026-09-19 要求的順序）
    const unscheduled = todos.filter((t) => !t.done && !t.dueDate);
    const section = container.createEl("details", { cls: "ws-unscheduled" });
    section.open = this.unscheduledOpen;
    section.addEventListener("toggle", () => {
      this.unscheduledOpen = section.open;
    });
    section.createEl("summary", { text: `未排定待辦（${unscheduled.length}）— 可拖進日期指定到期日` });

    // 快速新增（不帶到期日）
    const addRow = section.createDiv({ cls: "ws-unsch-add" });
    const input = addRow.createEl("input", { type: "text", placeholder: "新增未排定待辦…" });
    const addBtn = addRow.createEl("span", { cls: "ws-icon-btn", attr: { "aria-label": "新增" } });
    setIcon(addBtn, "plus-circle");
    const submit = async () => {
      const text = input.value.trim();
      if (!text) return;
      this.unscheduledOpen = true;
      await this.ctx.todoStore.add(text, null);
      this.render();
    };
    addBtn.onclick = submit;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });

    const listEl = section.createDiv({ cls: "ws-unsch-list" });
    for (const t of unscheduled) this.renderTodo(listEl, t, false);

    // ===== 已排定事項（已排程文章＋已排定待辦的總覽，不分月份） =====
    const scheduledEntries = this.scheduledEntries();
    const schSection = container.createEl("details", { cls: "ws-scheduled" });
    schSection.open = this.scheduledOpen;
    schSection.addEventListener("toggle", () => {
      this.scheduledOpen = schSection.open;
    });
    schSection.createEl("summary", { text: `已排定事項（${scheduledEntries.length}）` });
    const schList = schSection.createDiv({ cls: "ws-sch-list" });
    if (scheduledEntries.length === 0) {
      schList.createSpan({ cls: "ws-cal-hint", text: "尚無已排定的文章或待辦" });
    }
    this.renderScheduledList(schList, scheduledEntries, false);

    // ===== 檔案瀏覽（左欄樹最上面有釘選筆記／草稿／已排定事項三列） =====
    this.fileBrowser.render(container);
  }

  /**
   * 已排定事項：已排程文章 ＋ 有到期日的未完成待辦，不分月份，依日期由近到遠。
   * 底部的收合區與檔案瀏覽左欄那一列共用這一份。
   */
  private scheduledEntries(): ScheduledEntry[] {
    const entries: ScheduledEntry[] = [];
    for (const a of this.snapshot.articles) {
      if (a.status === "scheduled" && a.publishDate) {
        entries.push({ date: a.publishDate, kind: "article", article: a });
      }
    }
    for (const t of this.snapshot.todos) {
      if (!t.done && t.dueDate) entries.push({ date: t.dueDate, kind: "todo", todo: t });
    }
    // sort 是穩定排序，同一天維持「先文章後待辦」，與日期格子裡的順序一致
    return entries.sort((a, b) => a.date.localeCompare(b.date));
  }

  /** 已排定事項的清單本體。`compact` 給檔案瀏覽右欄用：那一欄很窄，日期省掉年份 */
  private renderScheduledList(list: HTMLElement, entries: ScheduledEntry[], compact: boolean) {
    const today = todayStr();
    for (const entry of entries) {
      const row = list.createDiv({ cls: "ws-sch-row" });
      const weekday = WEEKDAYS[new Date(entry.date + "T00:00:00").getDay()];
      row.createSpan({
        cls: "ws-sch-date",
        text: `${compact ? entry.date.slice(5) : entry.date}（${weekday}）`,
      });
      if (entry.kind === "article") this.renderArticle(row, entry.article, entry.date);
      else this.renderTodo(row, entry.todo, entry.date < today);
    }
  }

  /**
   * 檔案瀏覽左欄樹最上面的「已排定事項」那一列。
   *
   * 釘選筆記與草稿都是純檔案清單，檔案瀏覽自己就能列；已排定事項混著待辦，
   * 待辦不是檔案，只能整塊交回月曆畫（連帶勾選、原地編輯、拖曳改期都照舊能用）。
   */
  private browserViews(): FileBrowserCustomView[] {
    const entries = this.scheduledEntries();
    return [
      {
        key: SCHEDULED_KEY,
        icon: "calendar-clock",
        name: "已排定事項",
        count: entries.length,
        title: "所有已排程的文章與已排定的待辦（不分月份）",
        render: (list, filter) => {
          // 日期也拿來比對，打「09-21」就能只看那一天
          const hit = filter
            ? entries.filter(
                (e) => this.entryText(e).toLowerCase().includes(filter) || e.date.includes(filter)
              )
            : entries;
          if (hit.length === 0) {
            list.createSpan({
              cls: "ws-cal-hint",
              text: filter ? "沒有符合的事項" : "尚無已排定的文章或待辦",
            });
            return;
          }
          this.renderScheduledList(list.createDiv({ cls: "ht-fb-sch" }), hit, true);
        },
      },
    ];
  }

  /** 一列已排定事項的文字，給篩選比對用 */
  private entryText(entry: ScheduledEntry): string {
    return entry.kind === "article" ? entry.article.file.basename : entry.todo.text;
  }

  /** 開啟該日的每日筆記，不存在就先依核心外掛設定（格式／資料夾／範本）建立 */
  private async openDailyNote(dateStr: string, dailyNotes: Record<string, TFile>) {
    if (!appHasDailyNotesPluginLoaded()) {
      new Notice("請先在「設定 → 核心外掛」啟用「每日筆記」");
      return;
    }
    const m = wmoment(dateStr, "YYYY-MM-DD");
    let file: TFile | null | undefined = getDailyNote(m, dailyNotes);
    if (!file) {
      try {
        file = await createDailyNote(m);
      } catch (e) {
        new Notice("建立每日筆記失敗，請檢查每日筆記的資料夾與範本設定");
        return;
      }
    }
    if (file) await this.app.workspace.getLeaf("tab").openFile(file);
  }

  /**
   * 已排程／已發佈文章。`date` 是這一列所在的日期（格子的日期，或總覽列的日期）。
   *
   * 已排程：可拖曳改期，滑過出現 ✓（標為已發佈，實際發佈日就用這一格的日期）與 ×（取消排程回草稿）。
   * 已發佈：不可拖曳，滑過出現 ×（退回已排程）。
   */
  private renderArticle(parent: HTMLElement, article: Article, date: string) {
    const file = article.file;
    const published = article.status === "published";
    const overdue = !published && date < todayStr();
    const el = parent.createDiv({
      cls: `ws-cal-event ${published ? "ws-ev-published" : "ws-ev-scheduled"}${overdue ? " ws-ev-overdue" : ""}`,
    });
    el.createSpan({ text: `${published ? "✓ " : ""}${file.basename}` });
    el.setAttr("title", published ? `已發佈：${file.basename}` : file.basename);
    el.onclick = (e) => {
      e.stopPropagation();
      this.app.workspace.getLeaf("tab").openFile(file);
    };

    if (published) {
      const undo = el.createEl("span", { cls: "ws-icon-btn ws-ev-remove", attr: { "aria-label": "退回已排程", title: "" } });
      setIcon(undo, "x");
      undo.onclick = async (e) => {
        e.stopPropagation(); // 不讓點擊冒泡到 el.onclick 開啟筆記
        // 原本有預定發佈日就回到那一天；沒有的話（例如直接從草稿標成已發佈）
        // 就用實際發佈日，否則它會變成沒有日期、從月曆上整個消失
        const back = article.publishDate ?? date;
        await setArticleSchedule(this.app, file, {
          status: "scheduled",
          publishDate: back,
          publishedDate: null,
        });
        new Notice(`已退回排程：${file.basename} → ${back}`);
        this.render();
      };
      return;
    }

    const done = el.createEl("span", { cls: "ws-icon-btn ws-ev-publish", attr: { "aria-label": "標記為已發佈", title: "" } });
    setIcon(done, "check");
    done.onclick = async (e) => {
      e.stopPropagation(); // 不讓點擊冒泡到 el.onclick 開啟筆記
      // 實際發佈日用這一格的日期，補登以前發的文章才不用另外挑日期。
      // publish_date 刻意保留，事後才看得出有沒有照原訂日期發。
      await setArticleSchedule(this.app, file, { status: "published", publishedDate: date });
      new Notice(`已標記為已發佈：${file.basename}（${date}）`);
      this.render();
    };

    const rm = el.createEl("span", { cls: "ws-icon-btn ws-ev-remove", attr: { "aria-label": "取消排程", title: "" } });
    setIcon(rm, "x");
    rm.onclick = async (e) => {
      e.stopPropagation(); // 不讓點擊冒泡到 el.onclick 開啟筆記
      await setArticleSchedule(this.app, file, { status: "draft", publishDate: null });
      new Notice(`已取消排程：${file.basename}，狀態改回草稿`);
      this.render();
    };
    this.makeDraggable(el, { kind: "article", file });
  }

  /** 待辦：小勾勾可直接完成，未完成可拖曳；鉛筆可原地編輯內容；已排定的滑過會出現 × 可改回未排定。 */
  private renderTodo(parent: HTMLElement, item: TodoItem, overdue: boolean) {
    const el = parent.createDiv({ cls: `ws-cal-event ws-ev-todo${overdue ? " ws-ev-overdue" : ""}` });
    const cb = el.createEl("input", { type: "checkbox", cls: "ws-ev-check" });
    cb.onclick = async (e) => {
      e.stopPropagation();
      await this.ctx.todoStore.toggle(item);
      this.render();
    };
    const textSpan = el.createSpan({ text: item.text });
    el.setAttr("title", item.text);
    el.onclick = (e) => {
      e.stopPropagation();
      const f = this.ctx.todoStore.getFile();
      if (f) this.app.workspace.getLeaf("tab").openFile(f);
    };
    const edit = el.createEl("span", { cls: "ws-icon-btn ws-ev-edit", attr: { "aria-label": "編輯內容", title: "" } });
    setIcon(edit, "pencil");
    edit.onclick = (e) => {
      e.stopPropagation(); // 不讓點擊冒泡到 el.onclick 開啟 Todo 檔
      this.startEditTodo(el, textSpan, item);
    };
    if (item.dueDate) {
      const rm = el.createEl("span", { cls: "ws-icon-btn ws-ev-remove", attr: { "aria-label": "改為未排定", title: "" } });
      setIcon(rm, "x");
      rm.onclick = async (e) => {
        e.stopPropagation(); // 不讓點擊冒泡到 el.onclick 開啟 Todo 檔
        await this.ctx.todoStore.setDueDate(item, null);
        this.unscheduledOpen = true; // 展開底部收合區，讓使用者看到它移去哪裡
        new Notice(`已改為未排定待辦：${item.text}`);
        this.render();
      };
    }
    this.makeDraggable(el, { kind: "todo", item });
  }

  /**
   * 待辦原地編輯：文字換成輸入框，Enter 或點別處＝儲存、Esc＝取消，
   * 清空後儲存視同取消（不會存成空白待辦）。
   */
  private startEditTodo(el: HTMLElement, textSpan: HTMLElement, item: TodoItem) {
    if (el.querySelector(".ws-ev-edit-input")) return; // 已在編輯中
    this.editingTodo = true;
    textSpan.hide();
    el.draggable = false; // 在輸入框內拖選文字時不要觸發拖曳改期
    const input = el.createEl("input", { type: "text", cls: "ws-ev-edit-input", value: item.text });
    el.insertAfter(input, textSpan); // 輸入框放在原文字的位置
    input.onclick = (e) => e.stopPropagation(); // 不讓點擊冒泡到 el.onclick 開啟 Todo 檔
    input.focus();
    input.select();

    let finished = false; // Enter 儲存後緊接著會觸發 blur，防止重複執行
    const finish = async (save: boolean) => {
      if (finished) return;
      finished = true;
      this.editingTodo = false;
      const text = input.value.trim();
      if (save && text && text !== item.text) {
        await this.ctx.todoStore.setText(item, text);
      }
      this.render(); // 儲存後刷新；取消或無變動時重繪即還原
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  }

  private makeDraggable(el: HTMLElement, payload: DragPayload) {
    el.draggable = true;
    el.addEventListener("dragstart", (e) => {
      this.dragPayload = payload;
      el.addClass("ws-dragging");
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", payload.kind === "article" ? payload.file.basename : payload.item.text);
      }
    });
    el.addEventListener("dragend", () => el.removeClass("ws-dragging"));
  }

  private makeDropTarget(cell: HTMLElement, dateStr: string) {
    cell.addEventListener("dragover", (e) => {
      if (!this.dragPayload) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      cell.addClass("ws-drop-target");
    });
    cell.addEventListener("dragleave", () => cell.removeClass("ws-drop-target"));
    cell.addEventListener("drop", async (e) => {
      e.preventDefault();
      cell.removeClass("ws-drop-target");
      const p = this.dragPayload;
      this.dragPayload = null;
      if (!p) return;
      if (p.kind === "article") {
        // 一定要連 status 一起寫：草稿拖進來才會真的變成已排程，
        // 否則它會同時留在草稿區又出現在日期格子裡。
        // 原本就已排程的項目改期時，這個值等於沒變。
        await setArticleSchedule(this.app, p.file, { status: "scheduled", publishDate: dateStr });
      } else {
        await this.ctx.todoStore.setDueDate(p.item, dateStr);
      }
      this.render();
    });
  }

  /** 拖曳中懸停月份箭頭約半秒 → 自動翻頁 */
  private armFlipOnDrag(el: HTMLElement, delta: number) {
    el.addEventListener("dragover", (e) => {
      if (!this.dragPayload) return;
      e.preventDefault();
      el.addClass("ws-flip-hot");
      if (this.flipTimer === null) {
        this.flipTimer = window.setTimeout(() => {
          this.flipTimer = null;
          this.shiftMonth(delta);
        }, 500);
      }
    });
    el.addEventListener("dragleave", () => {
      el.removeClass("ws-flip-hot");
      if (this.flipTimer !== null) {
        window.clearTimeout(this.flipTimer);
        this.flipTimer = null;
      }
    });
  }
}

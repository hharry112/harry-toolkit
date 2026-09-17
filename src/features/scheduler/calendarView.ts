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
import { scanArticles, scanPinnedNotes, setArticleSchedule, setPinned } from "./articles";
import { FileBrowser } from "./fileBrowser";
import { AddTodoModal } from "./modals";
import { Article, TodoItem, formatDate, todayStr } from "./types";

export const CALENDAR_VIEW_TYPE = "writer-scheduler-calendar";

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

/** 拖曳中的項目，存在檢視實例上（跨月翻頁重繪後仍有效） */
type DragPayload = { kind: "article"; file: TFile } | { kind: "todo"; item: TodoItem };

/**
 * 發佈月曆（插件主畫面）：
 * - 點日期格子空白處 → 新增該天到期的待辦
 * - 已排程文章與未完成待辦可拖曳到別天改期
 * - 拖曳中懸停在上／下月箭頭約半秒會自動翻頁
 * - 底部依序為「釘選筆記」「草稿」「已排定事項」「未排定待辦」「檔案瀏覽」五個收合區；
 *   已排定事項是所有排程的總覽（不分月份），未排定待辦可拖進日期指定到期日
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
  /** 「釘選筆記」收合區的展開狀態，跨重繪保留，預設展開 */
  private pinnedOpen = true;
  /** 「草稿」收合區的展開狀態，跨重繪保留，預設展開 */
  private draftsOpen = true;
  /** 「已排定事項」收合區的展開狀態，跨重繪保留，預設展開 */
  private scheduledOpen = true;
  /** 是否正在原地編輯待辦（編輯中不自動重繪，避免毀掉輸入框） */
  private editingTodo = false;
  /** 底部的檔案瀏覽區；狀態存在這個實例上，跨重繪保留 */
  private fileBrowser: FileBrowser;

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
    nav.createEl("span", { cls: "ws-cal-hint", text: "點日期新增待辦，拖曳項目可改期" });
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
        attr: { "aria-label": hasDaily ? "開啟每日筆記" : "建立並開啟每日筆記" },
      });
      daynum.createSpan({ text: String(day) });
      if (hasDaily) daynum.createSpan({ cls: "ws-daily-dot" });
      daynum.onclick = (e) => {
        e.stopPropagation();
        this.openDailyNote(dateStr, dailyNotes);
      };

      for (const a of scheduledByDate.get(dateStr) ?? []) this.renderArticle(cell, a, dateStr);
      for (const a of publishedByDate.get(dateStr) ?? []) this.renderArticle(cell, a, dateStr);
      for (const t of todosByDate.get(dateStr) ?? []) this.renderTodo(cell, t, dateStr < today);

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

    // ===== 底部收合區的總開關 =====
    const secBar = container.createDiv({ cls: "ws-sec-bar" });
    const secBtn = (text: string, icon: string, open: boolean) => {
      const btn = secBar.createEl("span", { cls: "ws-sec-btn" });
      setIcon(btn.createSpan({ cls: "ws-sec-icon" }), icon);
      btn.createSpan({ text });
      btn.onclick = () => this.setAllSections(open);
    };
    secBtn("全部展開", "chevrons-down", true);
    secBtn("全部收合", "chevrons-up", false);

    // ===== 釘選筆記 =====
    const pinnedFiles = scanPinnedNotes(this.app);
    const pinSection = container.createEl("details", { cls: "ws-pinned" });
    pinSection.open = this.pinnedOpen;
    pinSection.addEventListener("toggle", () => {
      this.pinnedOpen = pinSection.open;
    });
    pinSection.createEl("summary", { text: `釘選筆記（${pinnedFiles.length}）` });
    const pinList = pinSection.createDiv({ cls: "ws-pinned-list" });
    if (pinnedFiles.length === 0) {
      pinList.createSpan({ cls: "ws-cal-hint", text: "尚無釘選筆記（在檔案上按右鍵 → 加入釘選）" });
    }
    for (const f of pinnedFiles) this.renderPinnedNote(pinList, f);

    // ===== 草稿（還沒排程的文章，可拖進日期直接排程） =====
    // 最近改過的排前面，正在寫的草稿會浮上來
    const drafts = articles
      .filter((a) => a.status === "draft")
      .sort((a, b) => b.file.stat.mtime - a.file.stat.mtime);
    const draftSection = container.createEl("details", { cls: "ws-drafts" });
    draftSection.open = this.draftsOpen;
    draftSection.addEventListener("toggle", () => {
      this.draftsOpen = draftSection.open;
    });
    draftSection.createEl("summary", { text: `草稿（${drafts.length}）— 可拖進日期排程` });
    const draftList = draftSection.createDiv({ cls: "ws-draft-list" });
    if (drafts.length === 0) {
      draftList.createSpan({
        cls: "ws-cal-hint",
        text: "尚無草稿（在筆記的 publish_status 填 draft）",
      });
    }
    for (const a of drafts) this.renderDraft(draftList, a.file);

    // ===== 已排定事項（已排程文章＋已排定待辦的總覽，不分月份） =====
    const scheduledEntries: ({ date: string } & (
      | { kind: "article"; article: Article }
      | { kind: "todo"; todo: TodoItem }
    ))[] = [];
    for (const a of articles) {
      if (a.status === "scheduled" && a.publishDate) scheduledEntries.push({ date: a.publishDate, kind: "article", article: a });
    }
    for (const t of todos) {
      if (!t.done && t.dueDate) scheduledEntries.push({ date: t.dueDate, kind: "todo", todo: t });
    }
    // 依日期由近到遠；sort 是穩定排序，同一天維持「先文章後待辦」，與上方格子內順序一致
    scheduledEntries.sort((a, b) => a.date.localeCompare(b.date));

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
    for (const entry of scheduledEntries) {
      const row = schList.createDiv({ cls: "ws-sch-row" });
      const weekday = WEEKDAYS[new Date(entry.date + "T00:00:00").getDay()];
      row.createSpan({ cls: "ws-sch-date", text: `${entry.date}（${weekday}）` });
      if (entry.kind === "article") this.renderArticle(row, entry.article, entry.date);
      else this.renderTodo(row, entry.todo, entry.date < today);
    }

    // ===== 未排定待辦（沒有到期日的未完成項目） =====
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

    // ===== 檔案瀏覽（預設收合，不影響月曆原本的畫面） =====
    this.fileBrowser.render(container);
  }

  /**
   * 底部五個收合區一次全開或全關。
   * 新增收合區時記得接進來，否則「全部展開」會漏掉它。
   */
  private setAllSections(open: boolean) {
    this.pinnedOpen = open;
    this.draftsOpen = open;
    this.scheduledOpen = open;
    this.unscheduledOpen = open;
    this.fileBrowser.setOpen(open);
    this.render();
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
      const undo = el.createEl("span", { cls: "ws-icon-btn ws-ev-remove", attr: { "aria-label": "退回已排程" } });
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

    const done = el.createEl("span", { cls: "ws-icon-btn ws-ev-publish", attr: { "aria-label": "標記為已發佈" } });
    setIcon(done, "check");
    done.onclick = async (e) => {
      e.stopPropagation(); // 不讓點擊冒泡到 el.onclick 開啟筆記
      // 實際發佈日用這一格的日期，補登以前發的文章才不用另外挑日期。
      // publish_date 刻意保留，事後才看得出有沒有照原訂日期發。
      await setArticleSchedule(this.app, file, { status: "published", publishedDate: date });
      new Notice(`已標記為已發佈：${file.basename}（${date}）`);
      this.render();
    };

    const rm = el.createEl("span", { cls: "ws-icon-btn ws-ev-remove", attr: { "aria-label": "取消排程" } });
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
    const edit = el.createEl("span", { cls: "ws-icon-btn ws-ev-edit", attr: { "aria-label": "編輯內容" } });
    setIcon(edit, "pencil");
    edit.onclick = (e) => {
      e.stopPropagation(); // 不讓點擊冒泡到 el.onclick 開啟 Todo 檔
      this.startEditTodo(el, textSpan, item);
    };
    if (item.dueDate) {
      const rm = el.createEl("span", { cls: "ws-icon-btn ws-ev-remove", attr: { "aria-label": "改為未排定" } });
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

  /** 草稿項目：點擊開啟筆記，拖到日期格子即排程。還沒有日期，所以沒有 ×。 */
  private renderDraft(parent: HTMLElement, file: TFile) {
    const el = parent.createDiv({ cls: "ws-cal-event ws-ev-draft" });
    el.createSpan({ text: file.basename });
    el.setAttr("title", file.path); // 同名筆記靠完整路徑分辨
    el.onclick = (e) => {
      e.stopPropagation();
      this.app.workspace.getLeaf("tab").openFile(file);
    };
    this.makeDraggable(el, { kind: "article", file });
  }

  /** 釘選筆記項目：點擊開啟，× 移除釘選。無日期概念，不可拖曳。 */
  private renderPinnedNote(parent: HTMLElement, file: TFile) {
    const el = parent.createDiv({ cls: "ws-cal-event ws-ev-pinned" });
    const pinIcon = el.createSpan({ cls: "ws-ev-pin-icon" });
    setIcon(pinIcon, "pin");
    el.createSpan({ text: file.basename });
    el.setAttr("title", file.path); // 同名筆記靠完整路徑分辨
    el.onclick = (e) => {
      e.stopPropagation();
      this.app.workspace.getLeaf("tab").openFile(file);
    };
    const rm = el.createEl("span", { cls: "ws-icon-btn ws-ev-remove", attr: { "aria-label": "移除釘選" } });
    setIcon(rm, "x");
    rm.onclick = async (e) => {
      e.stopPropagation(); // 不讓點擊冒泡到 el.onclick 開啟筆記
      await setPinned(this.app, file, false);
      this.render();
    };
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

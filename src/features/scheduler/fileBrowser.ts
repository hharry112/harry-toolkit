import { App, Keymap, Menu, Notice, TFile, TFolder, setIcon } from "obsidian";
import { scanPinnedNotes, setPinned } from "./articles";
import { ConfirmModal, RenameModal } from "./modals";
import type { FileSort, FileSortKey, SchedulerSettings } from "./types";

/** vault 根目錄的 path 是 "/"，設定裡用空字串表示，比較前一律正規化 */
const norm = (path: string) => (path === "/" ? "" : path);

/**
 * 「釘選筆記」在樹上是一列虛擬資料夾，選中時右欄改列全 vault 的釘選筆記。
 * 用冒號開頭是為了跟真實路徑錯開（vault 路徑不可能長這樣），
 * 它會被存進 `fileBrowserPicked`，也可以像資料夾一樣各記一份排序。
 */
const PINNED_KEY = ":pinned:";

/** 圖片類副檔名，只影響清單上的小圖示 */
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);

/** 名稱排序：numeric 讓 20260915 這種檔名照數字大小排，不會 10 排在 9 前面 */
const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, "zh-Hant", { numeric: true });

/**
 * 排序選單的六個選項。列的順序就是選單的順序：時間類把「新→舊」放前面，
 * 因為找最近改過的檔案是最常見的需求。
 */
const SORT_OPTIONS: { key: FileSortKey; asc: boolean; label: string }[] = [
  { key: "name", asc: true, label: "檔名（A→Z）" },
  { key: "name", asc: false, label: "檔名（Z→A）" },
  { key: "mtime", asc: false, label: "修改時間（新→舊）" },
  { key: "mtime", asc: true, label: "修改時間（舊→新）" },
  { key: "ctime", asc: false, label: "建立日期（新→舊）" },
  { key: "ctime", asc: true, label: "建立日期（舊→新）" },
];

function iconFor(file: TFile): string {
  if (file.extension === "md") return "file-text";
  if (IMAGE_EXT.has(file.extension)) return "image";
  if (file.extension === "canvas") return "layout-dashboard";
  if (file.extension === "pdf") return "file-type";
  return "file";
}

/**
 * 檔案瀏覽要向月曆借用的東西。
 *
 * 刻意只列必要的四項：這個區塊不知道也不需要知道 CalendarView 是誰，
 * 日後若要把它搬成獨立檢視，換一個宿主實作就好。
 */
export interface FileBrowserHost {
  app: App;
  settings: SchedulerSettings;
  save(): Promise<void>;
  /** 讓 .md 檔能拖到月曆日期格子排程（由月曆提供，與草稿共用同一份拖曳狀態） */
  makeDraggable(el: HTMLElement, file: TFile): void;
}

/**
 * 月曆底部的「檔案瀏覽」收合區。
 *
 * - 左欄是從 vault 根目錄長出來的資料夾樹，最上面一列是跨資料夾的「釘選筆記」，
 *   ★ 是常用資料夾快速跳轉，↑↓ 是排序
 * - 點資料夾選它（右欄換成它的檔案）、點檔案開啟（Ctrl／Cmd＋點開新分頁）
 * - .md 檔可拖到日期格子直接排程（其他檔案拖不動，沒有 frontmatter 可寫）
 * - 右鍵一律叫出 Obsidian 內建的檔案選單，不自己做重新命名／刪除
 *
 * 收合與篩選狀態存在實例上（跨重繪保留），選中的資料夾、展開狀態與常用清單存設定，
 * 所以重開 Obsidian 還會停在原本那個資料夾。
 */
export class FileBrowser {
  /** 預設展開，與月曆其他四個收合區一致（使用者 2026-09-18 要求） */
  private open = true;
  /** 篩選只對目前這一層有效，換資料夾就清掉 */
  private filter = "";
  /** 延後存檔的計時器（見 saveSoon） */
  private saveTimer: number | null = null;
  /**
   * 下一次畫樹時，要把選中的那一列捲進可視範圍。
   *
   * 只有 `pick()` 會把它立起來：從 ★ 常用資料夾跳過去時，那一列往往埋在
   * 清單捲動區的下面，不捲過去的話畫面看起來沒反應（使用者 2026-09-19 要求）。
   * 單純展開／收合不捲，不然畫面會一直自己跳。
   */
  private focusPicked = false;

  constructor(private host: FileBrowserHost) {}

  /**
   * 延後存檔。
   *
   * **絕對不要 `await` 存檔之後才重畫畫面。** `save()` 寫的是
   * `.obsidian/plugins/harry-toolkit/data.json`，而 vault 常常放在 Google Drive、
   * OneDrive 這類同步資料夾裡 —— 那裡寫一個檔案要經過同步驅動，慢上好幾秒是常態。
   * 等它回來才更新畫面，點一下資料夾就像卡住了（2026-09-18 實際踩到）。
   *
   * 這裡記的只是「上次停在哪個資料夾」「這個資料夾怎麼排序」，晚幾百毫秒寫進去
   * 完全沒有影響，所以一律先重畫、再讓存檔自己慢慢去。
   * 順便去抖動：連點好幾個資料夾時只寫最後一次。
   */
  private saveSoon() {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.host.save();
    }, 400);
  }

  /** 給月曆的「全部展開／全部收合」用；下次重繪時生效 */
  setOpen(open: boolean) {
    this.open = open;
  }

  render(container: HTMLElement) {
    if (!this.host.settings.fileBrowserEnabled) return;
    const section = container.createEl("details", { cls: "ht-fb" });
    section.open = this.open;
    section.addEventListener("toggle", () => {
      this.open = section.open;
    });
    section.createEl("summary", { cls: "ht-fb-summary" });
    const body = section.createDiv({ cls: "ht-fb-body" });
    this.renderBody(body);
  }

  /** 換資料夾或換選取時整塊重畫（工具列、篩選框、兩欄都會變） */
  private renderBody(body: HTMLElement) {
    body.empty();
    const root = this.host.app.vault.getRoot();
    const label = this.pickedLabel();

    // 收起來的時候也看得出停在哪個資料夾
    const summary = body.parentElement?.querySelector<HTMLElement>("summary");
    if (summary) summary.setText(`檔案瀏覽（${label}）`);

    // ===== 工具列：篩選框 ＋ 排序、常用資料夾 =====
    // 三樣東西併成一列：側邊欄的垂直空間很珍貴，月曆本體才是主角
    const bar = body.createDiv({ cls: "ht-fb-bar" });
    const input = bar.createEl("input", {
      type: "text",
      cls: "ht-fb-filter",
      placeholder: `篩選「${label}」裡的檔案…`,
      value: this.filter,
    });

    // 排序是「這個資料夾的」，提示文字要把資料夾名講出來，不然會以為是全域設定
    const sort = bar.createEl("span", {
      cls: "ws-icon-btn ht-fb-sort",
      attr: {
        "aria-label": `「${label}」的排序：${this.sortLabel(this.pickedKey())}`,
      },
    });
    setIcon(sort, "arrow-up-narrow-wide");
    sort.onclick = (e) => this.showSortMenu(e, body);

    const fav = bar.createEl("span", {
      cls: "ws-icon-btn ht-fb-fav",
      attr: { "aria-label": "常用資料夾" },
    });
    setIcon(fav, "star");
    fav.onclick = (e) => this.showFavMenu(e, body);

    // ===== 兩欄：左邊是資料夾樹，右邊只有選中那個資料夾裡的檔案 =====
    const cols = body.createDiv({ cls: "ht-fb-cols" });
    const left = cols.createDiv({ cls: "ht-fb-list ht-fb-folders" });
    const right = cols.createDiv({ cls: "ht-fb-list ht-fb-files" });

    input.addEventListener("input", () => {
      this.filter = input.value;
      this.renderFiles(right, body);
    });

    // 展開／收合只要重畫左欄就好，不必連工具列跟篩選框一起重建。
    // 釘選數量在這裡算一次傳進去：那是一趟全 vault 的掃描，
    // 不該每次點箭頭都重跑（右欄真正要用到釘選清單時才會再掃一次）
    const pinnedCount = scanPinnedNotes(this.host.app).length;
    const redrawTree = () => this.renderTree(left, root, body, redrawTree, pinnedCount);
    redrawTree();
    this.renderFiles(right, body);
  }

  /**
   * 左欄：資料夾樹。
   *
   * 一律從 vault 根目錄開始往下長，
   * **有子資料夾的目錄仍然留在左欄**，用箭頭展開、收合 —— 右欄只放檔案。
   * 點資料夾的名字只是選它（換右欄內容），樹不會跳掉；點箭頭才是展開收合。
   *
   * 一律照檔名 A→Z：這一欄是拿來導覽的，順序固定才好找，不跟著右欄的排序跑。
   */
  private renderTree(
    list: HTMLElement,
    root: TFolder,
    body: HTMLElement,
    redraw: () => void,
    pinnedCount: number
  ) {
    list.empty();
    const expanded = new Set(this.host.settings.fileBrowserExpanded ?? []);
    const picked = this.pickedFolder();

    // 樹最上面的「釘選筆記」：不是真的資料夾，選中時右欄改列全 vault 的釘選筆記
    const pinRow = list.createDiv({ cls: "ht-fb-row ht-fb-pinned-row" });
    pinRow.createSpan({ cls: "ht-fb-twist ht-fb-twist-empty" });
    setIcon(pinRow.createSpan({ cls: "ht-fb-icon" }), "pin");
    pinRow.createSpan({ cls: "ht-fb-name", text: `釘選筆記（${pinnedCount}）` });
    pinRow.setAttr("title", "整個 vault 的釘選筆記");
    if (this.isPinnedView()) pinRow.addClass("ht-fb-picked");
    pinRow.onclick = () => this.pick(PINNED_KEY, body);

    // 選中的資料夾埋在好幾層底下時（重開 Obsidian、或從 ★ 跳過去），
    // 把它的每一層祖先都打開，不然畫面上根本看不到自己選的是哪一個
    for (let p = picked.parent; p && !p.isRoot(); p = p.parent) {
      expanded.add(norm(p.path));
    }

    this.renderNode(
      list,
      root,
      0,
      expanded,
      this.isPinnedView() ? PINNED_KEY : norm(picked.path),
      body,
      redraw
    );

    // 從 ★ 跳過去時，選中的那一列可能埋在捲動區外面；捲過去才看得出畫面有反應
    if (this.focusPicked) {
      this.focusPicked = false;
      list.querySelector<HTMLElement>(".ht-fb-picked")?.scrollIntoView({ block: "nearest" });
    }
  }

  /** 樹上的一列，以及（展開時）它底下的子資料夾 */
  private renderNode(
    list: HTMLElement,
    folder: TFolder,
    depth: number,
    expanded: Set<string>,
    pickedPath: string,
    body: HTMLElement,
    redraw: () => void
  ) {
    const path = norm(folder.path);
    const subs = folder.children
      .filter((c): c is TFolder => c instanceof TFolder)
      .sort(byName);
    // 樹根一律是展開的：收起來的話整棵樹就只剩一列，沒有意義
    const isOpen = depth === 0 || expanded.has(path);

    const row = list.createDiv({ cls: "ht-fb-row ht-fb-folder-row" });
    // 縮排是真正的動態數值，交給 CSS 變數算，不在程式裡硬寫 padding
    row.style.setProperty("--ht-fb-depth", String(depth));

    const twist = row.createSpan({ cls: "ht-fb-twist" });
    if (subs.length > 0) {
      setIcon(twist, isOpen ? "chevron-down" : "chevron-right");
      twist.setAttr("aria-label", isOpen ? "收合" : "展開");
      twist.onclick = (e) => {
        // 箭頭只管展開收合，不換右欄。整列的點擊是另一回事（見下面的 row.onclick），
        // 不擋下冒泡的話會兩件事一起做
        e.stopPropagation();
        this.toggle(path, redraw);
      };
    } else {
      // 沒有子資料夾也要留出箭頭的位置，名稱才對得齊
      twist.addClass("ht-fb-twist-empty");
    }

    setIcon(row.createSpan({ cls: "ht-fb-icon" }), isOpen && subs.length > 0 ? "folder-open" : "folder");
    row.createSpan({ cls: "ht-fb-name", text: this.folderLabel(folder) });
    row.setAttr("title", folder.isRoot() ? "vault 根目錄" : folder.path);
    if (pickedPath === path) row.addClass("ht-fb-picked");
    // 點整列 = 選它（右欄換成它的檔案）＋ 順手展開收合，不必瞄準那個小箭頭。
    // 樹根不收合：收起來整棵樹就只剩一列
    row.onclick = () => this.pick(folder.path, body, subs.length > 0 && depth > 0);
    if (!folder.isRoot()) {
      row.addEventListener("contextmenu", (e) => this.showFileMenu(e, folder));
    }

    if (!isOpen) return;
    for (const sub of subs) {
      this.renderNode(list, sub, depth + 1, expanded, pickedPath, body, redraw);
    }
  }

  /** 展開／收合樹上的一個資料夾 */
  private toggle(path: string, redraw: () => void) {
    const set = new Set(this.host.settings.fileBrowserExpanded ?? []);
    if (set.has(path)) set.delete(path);
    else set.add(path);
    this.host.settings.fileBrowserExpanded = [...set];
    redraw();
    this.saveSoon();
  }

  /**
   * 右欄：選中那個資料夾裡的**檔案**，或（選中樹最上面那一列時）整個 vault 的釘選筆記。
   *
   * 子資料夾一律不列在這裡 —— 它們是左欄那棵樹的事。
   */
  private renderFiles(list: HTMLElement, body: HTMLElement) {
    list.empty();
    const pinnedView = this.isPinnedView();
    const q = this.filter.trim().toLowerCase();

    const source = pinnedView
      ? scanPinnedNotes(this.host.app)
      : this.pickedFolder().children.filter((c): c is TFile => c instanceof TFile);
    const files = source
      // 釘選筆記本來就都是 .md，這道篩選只對資料夾有意義
      .filter((f) => pinnedView || !this.host.settings.fileBrowserMdOnly || f.extension === "md")
      .filter((f) => !q || f.name.toLowerCase().includes(q))
      .sort(this.fileComparator(this.pickedKey()));

    if (files.length === 0) {
      list.createSpan({
        cls: "ws-cal-hint",
        text: q
          ? "沒有符合的檔案"
          : pinnedView
            ? "尚無釘選筆記（在檔案上按右鍵 → 加入釘選）"
            : "這個資料夾沒有檔案",
      });
      return;
    }

    for (const f of files) {
      const row = list.createDiv({ cls: "ht-fb-row ht-fb-file-row" });
      setIcon(row.createSpan({ cls: "ht-fb-icon" }), iconFor(f));
      // .md 是主場，副檔名沒有資訊量就不顯示；其他檔案留著才看得出型別
      row.createSpan({ cls: "ht-fb-name", text: f.extension === "md" ? f.basename : f.name });
      row.setAttr("title", f.path);
      row.onclick = (e) => {
        // Ctrl／Cmd＋點 → 新分頁，與 Obsidian 各處的開檔行為一致
        this.host.app.workspace.getLeaf(Keymap.isModEvent(e)).openFile(f);
      };
      row.addEventListener("contextmenu", (e) => this.showFileMenu(e, f));
      // 中鍵 → 新分頁；Chromium 會在中鍵按下時啟動自動捲動，要先擋掉才不會誤觸
      row.addEventListener("mousedown", (e) => {
        if (e.button === 1) e.preventDefault();
      });
      row.addEventListener("auxclick", (e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        this.host.app.workspace.getLeaf("tab").openFile(f);
      });
      // 只有 md 能排程：其他檔案沒有 frontmatter 可寫，拖過去也沒意義
      if (f.extension === "md") this.host.makeDraggable(row, f);
      if (!pinnedView) continue;
      // 釘選清單上就地取消釘選，不必再去右鍵選單找
      const unpin = row.createEl("span", {
        cls: "ws-icon-btn ht-fb-unpin",
        attr: { "aria-label": "移除釘選" },
      });
      setIcon(unpin, "pin-off");
      unpin.onclick = async (e) => {
        e.stopPropagation(); // 不讓點擊冒泡到 row.onclick 開啟筆記
        await setPinned(this.host.app, f, false);
        // frontmatter 寫入是使用者的資料，await 完才重畫；月曆那邊也會收到
        // metadataCache 的變更事件，兩邊不會打架
        this.renderBody(body);
      };
    }
  }

  /** 右欄要顯示哪個資料夾：vault 根目錄，或樹上被點選的某個資料夾 */
  private pickedFolder(): TFolder {
    const root = this.host.app.vault.getRoot();
    const picked = norm(this.host.settings.fileBrowserPicked);
    if (!picked) return root;
    const f = this.host.app.vault.getAbstractFileByPath(picked);
    // 那個資料夾可能已經被改名或刪掉：安靜退回 vault 根目錄，不要讓整個月曆跟著壞掉
    return f instanceof TFolder ? f : root;
  }

  /** 右欄現在列的是釘選筆記，而不是某個資料夾裡的檔案 */
  private isPinnedView(): boolean {
    return this.host.settings.fileBrowserPicked === PINNED_KEY;
  }

  /** 右欄現在這一份清單的識別字串（排序是照這個各記一份的） */
  private pickedKey(): string {
    return this.isPinnedView() ? PINNED_KEY : norm(this.pickedFolder().path);
  }

  /** 右欄現在這一份清單在畫面上的名字 */
  private pickedLabel(): string {
    return this.isPinnedView() ? "釘選筆記" : this.folderLabel(this.pickedFolder());
  }

  /** 資料夾在畫面上的名字；vault 根目錄沒有 name，用 vault 自己的名字 */
  private folderLabel(folder: TFolder): string {
    return folder.isRoot() ? this.host.app.vault.getName() : folder.name;
  }

  /**
   * 換右欄要看的資料夾。
   *
   * `alsoToggle` 為真時順便展開／收合它 —— 點整列就是這樣進來的，
   * 使用者不必瞄準前面那個小箭頭（2026-09-18 要求）。
   *
   * ★ 常用資料夾也走這裡：樹不會被縮小，只是選中那個資料夾並展開到它
   * （祖先由 `renderTree` 自動補開）。
   */
  private pick(path: string, body: HTMLElement, alsoToggle = false) {
    this.host.settings.fileBrowserPicked = path;
    this.filter = "";
    this.focusPicked = true;
    if (alsoToggle) {
      const set = new Set(this.host.settings.fileBrowserExpanded ?? []);
      const key = norm(path);
      if (set.has(key)) set.delete(key);
      else set.add(key);
      this.host.settings.fileBrowserExpanded = [...set];
    }
    this.renderBody(body);
    this.saveSoon();
  }

  /** 某個資料夾的排序方式；沒有單獨設定過就用設定裡的預設 */
  private sortFor(path: string): FileSort {
    const saved = this.host.settings.fileBrowserSortByFolder?.[norm(path)];
    if (saved) return saved;
    return {
      key: this.host.settings.fileBrowserSortKey,
      asc: this.host.settings.fileBrowserSortAsc,
    };
  }

  /** 某個資料夾目前的檔案比較函式 */
  private fileComparator(path: string): (a: TFile, b: TFile) => number {
    const { key, asc } = this.sortFor(path);
    const dir = asc ? 1 : -1;
    if (key === "name") return (a, b) => byName(a, b) * dir;
    const time = (f: TFile) => (key === "ctime" ? f.stat.ctime : f.stat.mtime);
    // 時間相同（同一批匯入、同一秒存檔）時退回檔名，順序才不會每次重畫都在跳
    return (a, b) => (time(a) - time(b)) * dir || byName(a, b);
  }

  /** 某個資料夾目前排序方式的說明文字，給按鈕的提示用 */
  private sortLabel(path: string): string {
    const { key, asc } = this.sortFor(path);
    const hit = SORT_OPTIONS.find((o) => o.key === key && o.asc === asc);
    return (hit ?? SORT_OPTIONS[0]).label;
  }

  /**
   * 記住某個資料夾的排序。
   *
   * 順手清掉已經不存在的資料夾紀錄 —— 不然改名或刪除過的資料夾會一直留在
   * `data.json` 裡愈積愈多。空字串是 vault 根目錄，`PINNED_KEY` 是釘選清單，
   * 兩個都不是真的資料夾，永遠留著。
   */
  private saveSort(path: string, sort: FileSort) {
    const map = this.host.settings.fileBrowserSortByFolder ?? {};
    const next: Record<string, FileSort> = { [norm(path)]: sort };
    for (const [p, s] of Object.entries(map)) {
      if (p === norm(path)) continue;
      if (!p || p === PINNED_KEY) next[p] = s;
      else if (this.host.app.vault.getAbstractFileByPath(p) instanceof TFolder) next[p] = s;
    }
    this.host.settings.fileBrowserSortByFolder = next;
    this.saveSoon();
  }

  private showSortMenu(e: MouseEvent, body: HTMLElement) {
    const menu = new Menu();
    const path = this.pickedKey();
    const { key, asc } = this.sortFor(path);

    // 標明這組排序只影響哪個資料夾：每個資料夾各記一份，不講清楚會以為是全域設定
    menu.addItem((i) => i.setTitle(`「${this.pickedLabel()}」的排序`).setDisabled(true));

    SORT_OPTIONS.forEach((o, i) => {
      // 換一種依據就畫一條分隔線，三組（檔名／修改／建立）一眼分得開
      if (i === 0 || o.key !== SORT_OPTIONS[i - 1].key) menu.addSeparator();
      menu.addItem((it) =>
        it
          .setTitle(o.label)
          .setChecked(o.key === key && o.asc === asc)
          .onClick(() => {
            this.saveSort(path, { key: o.key, asc: o.asc });
            this.renderBody(body);
          })
      );
    });

    // 沒有這一項的話，設定裡那組預設值就再也改不了了（選單只寫單一資料夾）
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle("設為其他資料夾的預設")
        .setIcon("check-check")
        .onClick(() => {
          this.host.settings.fileBrowserSortKey = key;
          this.host.settings.fileBrowserSortAsc = asc;
          this.saveSoon();
          new Notice(`還沒單獨設定過的資料夾，以後都照「${this.sortLabel(path)}」排。`);
        })
    );
    menu.showAtMouseEvent(e);
  }

  private showFavMenu(e: MouseEvent, body: HTMLElement) {
    const menu = new Menu();
    const favs = this.host.settings.favoriteFolders;
    // 「目前資料夾」＝右欄正在看的那一個（設定裡的根目錄是空字串，不是 "/"）
    const current = norm(this.pickedFolder().path);

    if (favs.length === 0) {
      menu.addItem((i) => i.setTitle("尚未設定常用資料夾").setDisabled(true));
    }
    for (const p of favs) {
      menu.addItem((i) =>
        i
          .setTitle(p || "vault 根目錄")
          .setIcon("folder")
          .onClick(() => this.pick(p, body))
      );
    }

    menu.addSeparator();
    // 釘選筆記不是資料夾，加進常用沒有意義；不擋的話會默默把 vault 根加進去
    if (this.isPinnedView()) {
      menu.addItem((i) => i.setTitle("釘選筆記不是資料夾，不能加入常用").setDisabled(true));
      menu.showAtMouseEvent(e);
      return;
    }
    const isFav = favs.includes(current);
    menu.addItem((i) =>
      i
        .setTitle(isFav ? "從常用移除目前資料夾" : "將目前資料夾加入常用")
        .setIcon(isFav ? "star-off" : "star")
        .onClick(() => {
          this.host.settings.favoriteFolders = isFav
            ? favs.filter((p) => p !== current)
            : [...favs, current];
          this.saveSoon();
        })
    );
    menu.showAtMouseEvent(e);
  }

  /**
   * 右鍵選單。
   *
   * `file-menu` 事件只是一份「公共選單」：各插件（含本插件的「排入發佈行程」「加入釘選」）
   * 往裡面加項目，誰都能觸發。但**檔案總管的「重新命名」「刪除」不在裡面** ——
   * 那些是檔案總管自己先加在私有選單上，再把公共選單併上去的，從外面觸發拿不到。
   * 所以常用的幾項只能自己做，做法與內建相同（`renameFile` 會連帶更新連結、
   * `trashFile` 遵循使用者的「已刪除檔案」設定）。
   */
  private showFileMenu(e: MouseEvent, file: TFile | TFolder) {
    e.preventDefault();
    e.stopPropagation();
    const app = this.host.app;
    const menu = new Menu();

    if (file instanceof TFile) {
      const f = file;
      menu.addItem((i) =>
        i
          .setTitle("在新分頁開啟")
          .setIcon("file-plus")
          .onClick(() => app.workspace.getLeaf("tab").openFile(f))
      );
      menu.addItem((i) =>
        i
          .setTitle("在右側開啟")
          .setIcon("separator-vertical")
          .onClick(() => app.workspace.getLeaf("split").openFile(f))
      );
      menu.addSeparator();
    }

    menu.addItem((i) =>
      i
        .setTitle("重新命名…")
        .setIcon("pencil")
        .onClick(() => this.promptRename(file))
    );
    if (file instanceof TFile) {
      const f = file;
      menu.addItem((i) =>
        i
          .setTitle("複製副本")
          .setIcon("copy")
          .onClick(() => this.duplicate(f))
      );
    }
    menu.addItem((i) =>
      i
        .setTitle("刪除")
        .setIcon("trash")
        .setWarning(true)
        .onClick(() => this.confirmDelete(file))
    );
    menu.addSeparator();

    app.workspace.trigger("file-menu", menu, file, "harry-toolkit-file-browser");
    menu.showAtMouseEvent(e);
  }

  private promptRename(file: TFile | TFolder) {
    const app = this.host.app;
    // .md 的副檔名不必每次重打；其他檔案連副檔名一起給，才有辦法改型別
    const isMd = file instanceof TFile && file.extension === "md";
    const initial = isMd ? (file as TFile).basename : file.name;

    new RenameModal(app, `重新命名：${file.name}`, initial, async (name) => {
      const finalName = isMd ? `${name}.md` : name;
      const newPath = this.pathIn(file, finalName);
      if (newPath === file.path) return;
      try {
        // 走 fileManager：指向這個檔的所有連結會一併更新，與檔案總管的重新命名同一條路
        await app.fileManager.renameFile(file, newPath);
      } catch (err) {
        new Notice("重新命名失敗，可能已經有同名的檔案或資料夾");
      }
    }).open();
  }

  private async duplicate(file: TFile) {
    const app = this.host.app;
    const ext = file.extension ? `.${file.extension}` : "";
    let n = 1;
    let path = this.pathIn(file, `${file.basename} ${n}${ext}`);
    while (app.vault.getAbstractFileByPath(path)) {
      path = this.pathIn(file, `${file.basename} ${++n}${ext}`);
    }
    try {
      const copy = await app.vault.copy(file, path);
      new Notice(`已複製：${copy.name}`);
    } catch (err) {
      new Notice("複製失敗");
    }
  }

  private confirmDelete(file: TFile | TFolder) {
    const app = this.host.app;
    const isFolder = file instanceof TFolder;
    new ConfirmModal(
      app,
      "確定要刪除？",
      isFolder
        ? `資料夾「${file.name}」連同裡面的所有檔案都會被刪除。`
        : `「${file.name}」會被刪除。`,
      "刪除",
      async () => {
        try {
          // trashFile 遵循「設定 → 檔案與連結 → 已刪除檔案」的選擇
          // （系統垃圾桶／vault 的 .trash／永久刪除），不自己決定怎麼刪
          await app.fileManager.trashFile(file);
          new Notice(`已刪除：${file.name}`);
        } catch (err) {
          new Notice("刪除失敗");
        }
      }
    ).open();
  }

  /** 在某個檔案／資料夾的同一層組出新路徑（vault 根目錄的 parent.path 是 "/"，要當成空的） */
  private pathIn(sibling: TFile | TFolder, name: string): string {
    const parent = sibling.parent?.path ?? "";
    return parent && parent !== "/" ? `${parent}/${name}` : name;
  }
}

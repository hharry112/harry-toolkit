import { App, Keymap, Menu, Notice, TFile, TFolder, setIcon } from "obsidian";
import { scanArticles, scanPinnedNotes, setPinned } from "./articles";
import { ConfirmModal, NameModal } from "./modals";
import type { FileSort, FileSortKey, SchedulerSettings } from "./types";

/** vault 根目錄的 path 是 "/"，設定裡用空字串表示，比較前一律正規化 */
const norm = (path: string) => (path === "/" ? "" : path);

/**
 * 左欄樹最上面那幾列「虛擬清單」的識別字串。
 *
 * 它們不是真的資料夾，但會被存進 `fileBrowserPicked`，也像資料夾一樣各記一份排序，
 * 所以一律用冒號包起來跟真實路徑錯開（vault 路徑不可能長這樣）。
 */
const PINNED_KEY = ":pinned:";
const DRAFTS_KEY = ":drafts:";
/** 「已排定事項」的內容由宿主（月曆）提供，key 定在這裡讓兩邊對得上 */
export const SCHEDULED_KEY = ":scheduled:";

/** 這個 key 是虛擬清單，不是資料夾路徑（清理孤兒排序紀錄時要放過它們） */
const isVirtualKey = (key: string) => key.startsWith(":");

/**
 * 虛擬清單的預設排序（沒有單獨設定過時用）。
 * 草稿照「最近改過的排前面」，跟月曆底部草稿區的順序一致，正在寫的會浮上來。
 */
const VIEW_SORT: Record<string, FileSort> = {
  [DRAFTS_KEY]: { key: "mtime", asc: false },
};

/** 圖片類副檔名，只影響清單上的小圖示 */
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);

/** 名稱排序：numeric 讓 20260915 這種檔名照數字大小排，不會 10 排在 9 前面 */
const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, "zh-Hant", { numeric: true });

/**
 * 排序選單的六個選項。列的順序就是選單的順序：時間類把「新→舊」放前面，
 * 因為找最近改過的檔案是最常見的需求。
 *
 * `short` 是工具列上那顆按鈕要顯示的文字。**那一列的橫向空間要留給篩選框**
 * （月曆常放在側邊欄），所以省掉括號與「時間／日期」兩個字；
 * 完整寫法留在選單與滑鼠提示裡，看得到也不會誤會。
 */
const SORT_OPTIONS: { key: FileSortKey; asc: boolean; label: string; short: string }[] = [
  { key: "name", asc: true, label: "檔名（A→Z）", short: "檔名 A→Z" },
  { key: "name", asc: false, label: "檔名（Z→A）", short: "檔名 Z→A" },
  { key: "mtime", asc: false, label: "修改時間（新→舊）", short: "修改 新→舊" },
  { key: "mtime", asc: true, label: "修改時間（舊→新）", short: "修改 舊→新" },
  { key: "ctime", asc: false, label: "建立日期（新→舊）", short: "建立 新→舊" },
  { key: "ctime", asc: true, label: "建立日期（舊→新）", short: "建立 舊→新" },
];

/**
 * 這個資料夾底下**所有層**的檔案。
 *
 * 只在篩選時用：沒打字時右欄照舊只列同一層（那是導覽，左邊那棵樹負責深度），
 * 一打字就變成「在這個資料夾底下找」—— 要找的東西埋在哪個子資料夾，
 * 本來就是使用者不記得才要找的事。走的是記憶體裡的 vault 樹，不讀檔案內容。
 */
function descendantFiles(folder: TFolder): TFile[] {
  const out: TFile[] = [];
  const walk = (f: TFolder) => {
    for (const c of f.children) {
      if (c instanceof TFile) out.push(c);
      else if (c instanceof TFolder) walk(c);
    }
  };
  walk(folder);
  return out;
}

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
  /**
   * 檔案瀏覽自己的拖曳（把檔案或資料夾搬到別的資料夾）開始與結束時通知宿主。
   *
   * 月曆收到 vault 事件會去抖動後自動重繪，而重繪會把整棵樹的 DOM 重建一次 ——
   * 拖到一半目標被抽掉，放開就落空了。拖曳期間請宿主先別重繪。
   */
  setDragging?(on: boolean): void;
  /**
   * 宿主自己畫的虛擬清單（目前只有「已排定事項」）。
   *
   * 右欄本來只會列檔案，但已排定事項裡混著待辦 —— 待辦不是檔案，排不進那條路，
   * 只好把那一塊交還給月曆畫。每次重畫都會重新呼叫，拿到的才是最新的資料。
   */
  customViews?(): FileBrowserCustomView[];
}

/** 宿主提供的一份虛擬清單，對應左欄樹最上面的一列 */
export interface FileBrowserCustomView {
  /** 存進 `fileBrowserPicked` 的識別字串，必須以冒號開頭（見 `isVirtualKey`） */
  key: string;
  icon: string;
  /** 畫面上的名字，不含數量 */
  name: string;
  count: number;
  /** 滑鼠提示 */
  title: string;
  /** 右欄內容；`filter` 是已經轉小寫、去頭尾空白的篩選字串，空清單的提示也由這裡畫 */
  render(list: HTMLElement, filter: string): void;
}

/**
 * 左欄樹最上面那幾列「虛擬清單」：不是真的資料夾，選中時右欄換成對應的內容。
 *
 * 內建的兩種（釘選筆記、草稿）都是純檔案清單，直接交給右欄現成的排序、篩選、
 * 右鍵選單與拖曳排程；宿主提供的那種帶著 `render`，由它自己畫。
 */
interface VirtualView {
  key: string;
  icon: string;
  name: string;
  count: number;
  title: string;
  /** 清單是空的時候要說什麼（只有檔案清單用得到） */
  empty: string;
  /** 檔案清單；`null` 表示改走 `render` */
  files: TFile[] | null;
  render?: (list: HTMLElement, filter: string) => void;
}

/**
 * 月曆底部的「檔案瀏覽」收合區。
 *
 * - 左欄是從 vault 根目錄長出來的資料夾樹，最上面幾列是跨資料夾的虛擬清單
 *   （釘選筆記／草稿／已排定事項），★ 是常用資料夾快速跳轉，↑↓ 是排序
 * - 點資料夾選它（右欄換成它的檔案）、點檔案開啟（Ctrl／Cmd＋點開新分頁）
 * - .md 檔可拖到日期格子直接排程（其他檔案沒有 frontmatter 可寫，排了沒意義）
 * - 檔案與資料夾都可以拖到左欄的資料夾上搬過去
 * - 右鍵：資料夾最上面是「在這裡新增筆記／新增資料夾」，接著是自己做的
 *   重新命名／複製副本／刪除（`file-menu` 拿不到內建那幾項，見 AGENTS 的踩雷紀錄），
 *   最後併上 `file-menu` 這份公共選單
 *
 * 收合與篩選狀態存在實例上（跨重繪保留），選中的資料夾、展開狀態與常用清單存設定，
 * 所以重開 Obsidian 還會停在原本那個資料夾。
 */
export class FileBrowser {
  /** 預設展開，與月曆其他四個收合區一致（使用者 2026-09-18 要求） */
  private open = true;
  /** 篩選字串；找的範圍是選中的資料夾**連同它底下所有子資料夾**，換資料夾就清掉 */
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
  /**
   * 左欄那棵樹捲到哪裡。
   *
   * 換資料夾、展開收合都會把整棵樹的 DOM 重建一次，而清空元素會讓 `scrollTop` 歸零 ——
   * 不自己記著的話，每點一下樹就先跳回最上面，再被 `scrollIntoView` 拉到剛好露出
   * 選中那一列的位置，看起來就像「我點的資料夾被排到最下面去了」（2026-09-19 使用者回報）。
   */
  private treeScroll = 0;
  /**
   * 正在被拖曳的檔案或資料夾（放到左欄某個資料夾上就是搬過去）。
   *
   * 一定要自己記著，不能只靠 `dataTransfer`：`dragover` 階段讀不到 `getData` 的內容
   * （瀏覽器的安全限制），而「這個資料夾收不收得下」正是要在那個階段就決定的事 ——
   * 不在那時候 `preventDefault`，游標就會一直是禁止符號。
   */
  private drag: TFile | TFolder | null = null;
  /** 拖曳懸停在收合的資料夾上，準備自動展開它的計時器（見 armExpand） */
  private expandTimer: number | null = null;
  /** 上面那個計時器正在等哪個資料夾；游標換到別一列時要重新計時 */
  private expandTarget: string | null = null;

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
    // 重畫就表示拖曳的來源那一列即將消失（例如 md 檔被拖到日期格子排程，月曆整個重繪）——
    // 那種情形下來源元素早一步被抽掉，它身上的 dragend 不保證還會來。
    // 狀態卡在「拖曳中」的話，宿主會以為拖放還沒結束而永遠不重繪，所以在這裡收乾淨
    this.endDrag();
    body.empty();
    const root = this.host.app.vault.getRoot();
    // 虛擬清單在這裡算一次就好：每一份都是一趟全 vault 掃描，
    // 而樹會因為展開／收合被單獨重畫（redrawTree），寫在裡面等於每點一次箭頭就掃一輪
    const views = this.views();
    const label = this.pickedLabel(views);

    // 收起來的時候也看得出停在哪個資料夾
    const summary = body.parentElement?.querySelector<HTMLElement>("summary");
    if (summary) summary.setText(`檔案瀏覽（${label}）`);

    // ===== 工具列：篩選框 ＋ 排序、常用資料夾 =====
    // 三樣東西併成一列：側邊欄的垂直空間很珍貴，月曆本體才是主角
    const bar = body.createDiv({ cls: "ht-fb-bar" });
    const input = bar.createEl("input", {
      type: "text",
      cls: "ht-fb-filter",
      // 文案要跟著情境走：虛擬清單裡列的不一定是檔案，資料夾則要講明「連子資料夾一起找」——
      // 找到本層以外的東西卻沒說，使用者會以為插件壞了
      placeholder: this.currentView(views)
        ? `篩選「${label}」…`
        : `搜尋「${label}」與子資料夾…`,
      value: this.filter,
    });

    // 排序是「這個資料夾的」，提示文字要把資料夾名講出來，不然會以為是全域設定。
    // 宿主自己畫的清單（已排定事項照日期排）套不上這組排序，按鈕就不要出現 —— 留著也點不動
    if (!this.currentView(views)?.render) {
      const sortKey = this.pickedKey(views);
      const sort = bar.createEl("span", {
        cls: "ws-icon-btn ht-fb-sort",
        attr: {
          "aria-label": `「${label}」的排序：${this.sortLabel(sortKey)}（點擊更換）`,
        },
      });
      setIcon(sort.createSpan({ cls: "ht-fb-sort-icon" }), "arrow-up-narrow-wide");
      // 排序方式直接寫在按鈕上：每個資料夾各記一份，只靠圖示的話根本看不出現在是哪一種
      sort.createSpan({ cls: "ht-fb-sort-label", text: this.sortShort(sortKey) });
      sort.onclick = (e) => this.showSortMenu(e, body, views);
    }

    const fav = bar.createEl("span", {
      cls: "ws-icon-btn ht-fb-fav",
      attr: { "aria-label": "常用資料夾" },
    });
    setIcon(fav, "star");
    fav.onclick = (e) => this.showFavMenu(e, body, views);

    // ===== 兩欄：左邊是資料夾樹，右邊只有選中那個資料夾裡的檔案 =====
    const cols = body.createDiv({ cls: "ht-fb-cols" });
    const left = cols.createDiv({ cls: "ht-fb-list ht-fb-folders" });
    // 使用者自己捲的位置也要記下來，下次重畫才回得到原處
    left.addEventListener("scroll", () => {
      this.treeScroll = left.scrollTop;
    });
    const right = cols.createDiv({ cls: "ht-fb-list ht-fb-files" });

    input.addEventListener("input", () => {
      this.filter = input.value;
      this.renderFiles(right, body, views);
    });

    // 展開／收合只要重畫左欄就好，不必連工具列跟篩選框一起重建
    const redrawTree = () => this.renderTree(left, root, body, redrawTree, views);
    redrawTree();
    this.renderFiles(right, body, views);
  }

  /**
   * 左欄樹最上面那幾列虛擬清單。
   *
   * 每一份都要掃一次 vault（釘選看 frontmatter 的 `pinned`、草稿看 `publish_status`），
   * 所以只在 `renderBody` 呼叫一次，算出來的清單直接傳給右欄用，不要重掃。
   */
  private views(): VirtualView[] {
    const app = this.host.app;
    const pinned = scanPinnedNotes(app);
    // 草稿的掃描範圍跟著「文章掃描資料夾」設定走，與月曆底部的草稿區同一份來源
    const drafts = scanArticles(app, this.host.settings)
      .filter((a) => a.status === "draft")
      .map((a) => a.file);

    const views: VirtualView[] = [
      {
        key: PINNED_KEY,
        icon: "pin",
        name: "釘選筆記",
        count: pinned.length,
        title: "整個 vault 的釘選筆記",
        empty: "尚無釘選筆記（在檔案上按右鍵 → 加入釘選）",
        files: pinned,
      },
      {
        key: DRAFTS_KEY,
        icon: "pencil-line",
        name: "草稿",
        count: drafts.length,
        title: "還沒排程的草稿，可拖到日期格子排程",
        // 提示要講「怎麼做」而不是「欄位叫什麼」：第一次用的人不知道有 frontmatter 這回事
        empty: "尚無草稿（在筆記上按右鍵 →「標記為草稿」）",
        files: drafts,
      },
    ];
    for (const v of this.host.customViews?.() ?? []) {
      views.push({ ...v, empty: "", files: null });
    }
    return views;
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
    views: VirtualView[]
  ) {
    list.empty();
    const expanded = new Set(this.host.settings.fileBrowserExpanded ?? []);
    const picked = this.pickedFolder();
    const current = this.currentView(views);

    // 樹最上面那幾列虛擬清單（釘選筆記／草稿／已排定事項）：
    // 不是真的資料夾，選中時右欄整個換成它們的內容。包一層才好跟底下的資料夾畫一條分界
    const head = list.createDiv({ cls: "ht-fb-virtual" });
    for (const v of views) {
      const row = head.createDiv({ cls: "ht-fb-row ht-fb-virtual-row" });
      row.createSpan({ cls: "ht-fb-twist ht-fb-twist-empty" });
      setIcon(row.createSpan({ cls: "ht-fb-icon" }), v.icon);
      row.createSpan({ cls: "ht-fb-name", text: `${v.name}（${v.count}）` });
      row.setAttr("title", v.title);
      if (current?.key === v.key) row.addClass("ht-fb-picked");
      row.onclick = () => this.pick(v.key, body);
    }

    // 選中的資料夾埋在好幾層底下時（重開 Obsidian、或從 ★ 跳過去），
    // 把它的每一層祖先都打開，不然畫面上根本看不到自己選的是哪一個
    for (let p = picked.parent; p && !p.isRoot(); p = p.parent) {
      expanded.add(norm(p.path));
    }

    this.renderNode(list, root, 0, expanded, current ? current.key : norm(picked.path), body, redraw);

    // 從 ★ 跳過去時，選中的那一列可能埋在捲動區外面；捲過去才看得出畫面有反應
    // 先回到原本捲到的位置，再決定要不要為了選中那一列再捲。
    // 順序不能反：從 0 開始捲的話，`nearest` 只會把那一列剛好推到可視範圍的邊緣上
    list.scrollTop = this.treeScroll;

    if (this.focusPicked) {
      this.focusPicked = false;
      const row = list.querySelector<HTMLElement>(".ht-fb-picked");
      // 本來就看得見就別動它（點一個眼前的資料夾，畫面不該自己跳）；
      // 真的在可視範圍外（從 ★ 跳過去）才捲，而且捲到中間，比貼著邊緣好找
      if (row && !this.isVisibleIn(list, row)) row.scrollIntoView({ block: "center" });
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
      // 空的 title 中斷繼承：不設的話會跟整列那份路徑提示同時冒出來（見 AGENTS 的提示框規則）
      twist.setAttr("title", "");
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
    // 每一列都能接住拖過來的檔案或資料夾（放開＝搬進去），vault 根目錄也算一個目的地
    this.makeFolderDrop(row, folder, body, redraw, expanded);
    // vault 根目錄也要有右鍵選單 —— 在根目錄底下新增筆記、資料夾是很正常的事。
    // 它自己不能改名、不能刪，那幾項由 showFileMenu 判斷後不放進去
    row.addEventListener("contextmenu", (e) => this.showFileMenu(e, folder, body));
    // 資料夾本身也能被拖走；vault 根目錄沒有上一層，搬不動
    if (!folder.isRoot()) this.makeMovable(row, folder);

    if (!isOpen) return;
    for (const sub of subs) {
      this.renderNode(list, sub, depth + 1, expanded, pickedPath, body, redraw);
    }
  }

  /**
   * 這一列是不是完整落在清單的可視範圍內。
   *
   * 用 `getBoundingClientRect` 兩邊相減，不要用 `offsetTop`：那是相對於最近的
   * 定位祖先算的，而清單本身沒有 `position: relative`，量出來會是別人的座標。
   */
  private isVisibleIn(list: HTMLElement, row: HTMLElement): boolean {
    const r = row.getBoundingClientRect();
    const box = list.getBoundingClientRect();
    return r.top >= box.top && r.bottom <= box.bottom;
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
   * 讓這一列可以被拖走（放到左欄某個資料夾上＝搬過去）。
   *
   * `.md` 檔同時也是月曆的拖曳來源（拖到日期格子排程）：兩邊各自記自己的狀態，
   * 由放開的地方決定會發生什麼事 —— 日期格子只認月曆那一份，資料夾只認這一份。
   */
  private makeMovable(el: HTMLElement, item: TFile | TFolder) {
    el.draggable = true;
    el.addEventListener("dragstart", (e) => {
      this.drag = item;
      this.host.setDragging?.(true);
      el.addClass("ws-dragging");
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", item.name);
      }
    });
    el.addEventListener("dragend", () => {
      el.removeClass("ws-dragging");
      this.endDrag();
    });
  }

  /** 拖曳結束（放開、或中途取消）：收掉狀態、停掉自動展開、讓宿主恢復重繪 */
  private endDrag() {
    this.drag = null;
    this.cancelExpand();
    this.host.setDragging?.(false);
  }

  /**
   * 讓左欄的一列資料夾接得住拖過來的檔案或資料夾。
   *
   * 懸停在收合的資料夾上約半秒會自動展開，才有辦法一路拖到深處的子資料夾
   * （與月曆拖曳懸停箭頭自動翻月份同一套做法）。
   */
  private makeFolderDrop(
    row: HTMLElement,
    folder: TFolder,
    body: HTMLElement,
    redraw: () => void,
    expanded: Set<string>
  ) {
    row.addEventListener("dragover", (e) => {
      // 不 preventDefault 就等於「這裡不能放」，游標會是禁止符號 —— 正是我們要的
      if (!this.canDrop(folder)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      row.addClass("ht-fb-drop");
      this.armExpand(folder, expanded, redraw);
    });
    row.addEventListener("dragleave", () => {
      row.removeClass("ht-fb-drop");
      this.cancelExpand(norm(folder.path));
    });
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.removeClass("ht-fb-drop");
      const item = this.drag;
      // 先把拖曳狀態收乾淨：搬完會重畫，來源那一列會跟著消失，
      // 它身上的 dragend 就不一定還來得及來（真的來了再跑一次也無妨）
      this.endDrag();
      if (item) void this.moveInto(item, folder, body);
    });
  }

  /** 現在拖著的東西能不能放進這個資料夾 */
  private canDrop(folder: TFolder): boolean {
    const item = this.drag;
    if (!item) return false;
    // 本來就在裡面了，搬過去等於沒事
    if (norm(item.parent?.path ?? "") === norm(folder.path)) return false;
    if (item instanceof TFolder) {
      // 資料夾不能搬進自己，也不能搬進自己底下的子孫 —— 那是把整棵子樹連根拔起，
      // Obsidian 會丟錯，畫面上則像是資料夾憑空消失
      for (let p: TFolder | null = folder; p; p = p.parent) {
        if (p === item) return false;
      }
    }
    return true;
  }

  /** 拖曳懸停在收合的資料夾上約半秒 → 自動展開，才拖得進裡面的子資料夾 */
  private armExpand(folder: TFolder, expanded: Set<string>, redraw: () => void) {
    const path = norm(folder.path);
    // 樹根一律是展開的，等它沒有意義；沒有子資料夾的更不用等
    if (folder.isRoot() || expanded.has(path)) return;
    if (!folder.children.some((c) => c instanceof TFolder)) return;
    if (this.expandTarget === path) return; // 已經在等這一列了
    this.cancelExpand();
    this.expandTarget = path;
    this.expandTimer = window.setTimeout(() => {
      this.expandTimer = null;
      this.expandTarget = null;
      this.toggle(path, redraw);
    }, 500);
  }

  /**
   * 停掉自動展開的等待。
   *
   * `path` 是「離開的是哪一列」：游標從 A 滑到 B 時，`dragleave A` 不保證早於
   * `dragover B`，晚到的那一則若無條件取消，就會把剛替 B 排好的計時器清掉，
   * 資料夾永遠等不到展開。所以只有正在等的就是這一列時才取消。
   */
  private cancelExpand(path?: string) {
    if (path !== undefined && this.expandTarget !== path) return;
    if (this.expandTimer !== null) window.clearTimeout(this.expandTimer);
    this.expandTimer = null;
    this.expandTarget = null;
  }

  /**
   * 把檔案或資料夾搬進另一個資料夾。
   *
   * 走 `fileManager.renameFile` —— 在 Obsidian 眼裡搬家就是換一個路徑，
   * 指向它的所有連結會一併更新，與右鍵那個「重新命名」同一條路。
   */
  private async moveInto(item: TFile | TFolder, folder: TFolder, body: HTMLElement) {
    const app = this.host.app;
    const dir = norm(folder.path);
    const dest = dir ? `${dir}/${item.name}` : item.name;
    const where = this.folderLabel(folder);
    // 搬完之後 item 還是同一個物件，但 path 已經換成新的了 —— 舊路徑要先抄下來
    const from = norm(item.path);

    if (app.vault.getAbstractFileByPath(dest)) {
      // 絕不覆蓋：同名的那一個可能是使用者辛苦寫的東西，蓋掉就回不來了
      new Notice(`「${where}」裡已經有「${item.name}」，沒有移動。`);
      return;
    }
    try {
      await app.fileManager.renameFile(item, dest);
    } catch (err) {
      new Notice("移動失敗");
      return;
    }
    // 搬走的正好是右欄正在看的資料夾（或它的祖先）時，把記住的路徑跟著改掉；
    // 不然重畫時舊路徑已經不存在，右欄會安靜地跳回 vault 根目錄
    if (item instanceof TFolder) {
      const picked = norm(this.host.settings.fileBrowserPicked);
      if (picked === from || picked.startsWith(`${from}/`)) {
        this.host.settings.fileBrowserPicked = dest + picked.slice(from.length);
        this.saveSoon();
      }
    }
    new Notice(`已移動到「${where}」：${item.name}`);
    // 不等月曆那邊的 vault 事件（去抖動 300 毫秒才重繪）：自己先把清單換掉，放開就看得到結果
    this.renderBody(body);
  }

  /**
   * 右欄：選中那個資料夾裡的**檔案**，或（選中樹最上面那幾列時）對應的虛擬清單。
   *
   * 子資料夾一律不列在這裡 —— 它們是左欄那棵樹的事。
   */
  private renderFiles(list: HTMLElement, body: HTMLElement, views: VirtualView[]) {
    list.empty();
    const view = this.currentView(views);
    const q = this.filter.trim().toLowerCase();

    // 已排定事項那種混著待辦的清單，整塊交還給宿主畫（空清單的提示也是它畫）
    if (view?.render) {
      view.render(list, q);
      return;
    }

    // 沒打字時只列同一層（導覽是左邊那棵樹的事）；一打字就連子資料夾一起找
    const folder = view ? null : this.pickedFolder();
    const base = folder ? norm(folder.path) : "";
    const source = folder
      ? q
        ? descendantFiles(folder)
        : folder.children.filter((c): c is TFile => c instanceof TFile)
      : (view?.files ?? []);
    const files = source
      // 虛擬清單本來就都是 .md，這道篩選只對資料夾有意義
      .filter((f) => view !== null || !this.host.settings.fileBrowserMdOnly || f.extension === "md")
      .filter((f) => !q || f.name.toLowerCase().includes(q))
      .sort(this.fileComparator(this.pickedKey(views)));

    if (files.length === 0) {
      list.createSpan({
        cls: "ws-cal-hint",
        text: q
          ? view
            ? "沒有符合的項目"
            : "這個資料夾與底下的子資料夾都沒有符合的檔案"
          : (view?.empty ?? "這個資料夾沒有檔案"),
      });
      return;
    }

    for (const f of files) {
      const row = list.createDiv({ cls: "ht-fb-row ht-fb-file-row" });
      setIcon(row.createSpan({ cls: "ht-fb-icon" }), iconFor(f));
      // .md 是主場，副檔名沒有資訊量就不顯示；其他檔案留著才看得出型別
      row.createSpan({ cls: "ht-fb-name", text: f.extension === "md" ? f.basename : f.name });
      row.setAttr("title", f.path);
      // 篩選撈到子資料夾裡的檔案時，右邊補上它相對於目前資料夾的位置。
      // 不標的話，兩個同名的筆記看起來一模一樣，也看不出自己已經找到本層以外了
      if (folder) {
        const parent = norm(f.parent?.path ?? "");
        if (parent !== base) {
          row.createSpan({ cls: "ht-fb-sub", text: base ? parent.slice(base.length + 1) : parent });
        }
      }
      row.onclick = (e) => {
        // Ctrl／Cmd＋點 → 新分頁，與 Obsidian 各處的開檔行為一致
        this.host.app.workspace.getLeaf(Keymap.isModEvent(e)).openFile(f);
      };
      row.addEventListener("contextmenu", (e) => this.showFileMenu(e, f, body));
      // 中鍵 → 新分頁；Chromium 會在中鍵按下時啟動自動捲動，要先擋掉才不會誤觸
      row.addEventListener("mousedown", (e) => {
        if (e.button === 1) e.preventDefault();
      });
      row.addEventListener("auxclick", (e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        this.host.app.workspace.getLeaf("tab").openFile(f);
      });
      // 任何檔案都能拖到左欄的資料夾上搬家（圖片、PDF 也是要整理的東西）；
      // 只有 md 額外能拖到日期格子排程 —— 其他檔案沒有 frontmatter 可寫，排了也沒意義
      this.makeMovable(row, f);
      if (f.extension === "md") this.host.makeDraggable(row, f);
      if (view?.key !== PINNED_KEY) continue;
      // 釘選清單上就地取消釘選，不必再去右鍵選單找
      const unpin = row.createEl("span", {
        cls: "ws-icon-btn ht-fb-unpin",
        attr: { "aria-label": "移除釘選", title: "" },
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

  /** 右欄現在列的是哪一份虛擬清單；`null` 表示在看某個資料夾裡的檔案 */
  private currentView(views: VirtualView[]): VirtualView | null {
    return views.find((v) => v.key === this.host.settings.fileBrowserPicked) ?? null;
  }

  /** 右欄現在這一份清單的識別字串（排序是照這個各記一份的） */
  private pickedKey(views: VirtualView[]): string {
    return this.currentView(views)?.key ?? norm(this.pickedFolder().path);
  }

  /** 右欄現在這一份清單在畫面上的名字 */
  private pickedLabel(views: VirtualView[]): string {
    return this.currentView(views)?.name ?? this.folderLabel(this.pickedFolder());
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
    // 虛擬清單可以有自己的預設（草稿照修改時間新→舊），沒訂的就跟資料夾一樣走全域預設
    const view = VIEW_SORT[path];
    if (view) return view;
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

  /** 某個資料夾目前的排序選項；設定值對不上任何一個時退回第一個（檔名 A→Z） */
  private sortOption(path: string) {
    const { key, asc } = this.sortFor(path);
    return SORT_OPTIONS.find((o) => o.key === key && o.asc === asc) ?? SORT_OPTIONS[0];
  }

  /** 完整寫法，給選單與滑鼠提示用 */
  private sortLabel(path: string): string {
    return this.sortOption(path).label;
  }

  /** 精簡寫法，給工具列那顆按鈕用 */
  private sortShort(path: string): string {
    return this.sortOption(path).short;
  }

  /**
   * 記住某個資料夾的排序。
   *
   * 順手清掉已經不存在的資料夾紀錄 —— 不然改名或刪除過的資料夾會一直留在
   * `data.json` 裡愈積愈多。空字串是 vault 根目錄，冒號開頭的是虛擬清單，
   * 都不是真的資料夾，永遠留著。
   */
  private saveSort(path: string, sort: FileSort) {
    const map = this.host.settings.fileBrowserSortByFolder ?? {};
    const next: Record<string, FileSort> = { [norm(path)]: sort };
    for (const [p, s] of Object.entries(map)) {
      if (p === norm(path)) continue;
      if (!p || isVirtualKey(p)) next[p] = s;
      else if (this.host.app.vault.getAbstractFileByPath(p) instanceof TFolder) next[p] = s;
    }
    this.host.settings.fileBrowserSortByFolder = next;
    this.saveSoon();
  }

  private showSortMenu(e: MouseEvent, body: HTMLElement, views: VirtualView[]) {
    const menu = new Menu();
    const path = this.pickedKey(views);
    const { key, asc } = this.sortFor(path);

    // 標明這組排序只影響哪個資料夾：每個資料夾各記一份，不講清楚會以為是全域設定
    menu.addItem((i) => i.setTitle(`「${this.pickedLabel(views)}」的排序`).setDisabled(true));

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

  private showFavMenu(e: MouseEvent, body: HTMLElement, views: VirtualView[]) {
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
    // 虛擬清單不是資料夾，加進常用沒有意義；不擋的話會默默把 vault 根加進去
    const view = this.currentView(views);
    if (view) {
      menu.addItem((i) => i.setTitle(`「${view.name}」不是資料夾，不能加入常用`).setDisabled(true));
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
  private showFileMenu(e: MouseEvent, file: TFile | TFolder, body: HTMLElement) {
    e.preventDefault();
    e.stopPropagation();
    const app = this.host.app;
    const menu = new Menu();

    if (file instanceof TFolder) {
      const folder = file;
      // 放在最上面：在樹上對著一個資料夾按右鍵，最常想做的就是「在這裡開一篇新的」
      menu.addItem((i) =>
        i
          .setTitle("在這裡新增筆記…")
          .setIcon("file-plus")
          .onClick(() => this.promptCreate(folder, body, "note"))
      );
      menu.addItem((i) =>
        i
          .setTitle("在這裡新增資料夾…")
          .setIcon("folder-plus")
          .onClick(() => this.promptCreate(folder, body, "folder"))
      );
      menu.addSeparator();
    }

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

    // vault 根目錄改不了名也刪不得（它就是 vault 本身），那幾項不要出現 ——
    // 放著也只會在按下去之後得到一句錯誤訊息
    if (!(file instanceof TFolder && file.isRoot())) {
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
    }

    app.workspace.trigger("file-menu", menu, file, "harry-toolkit-file-browser");
    menu.showAtMouseEvent(e);
  }

  /**
   * 在某個資料夾裡新增筆記或子資料夾。
   *
   * **先問名字再建立**，不學內建檔案總管那套「先建一個『未命名』再就地改名」——
   * 那需要樹上的行內編輯，這一區沒有，會變成建好之後還得再按一次右鍵去改名。
   *
   * 建完把右欄切過去：東西建在看不到的地方，會讓人以為沒成功。新筆記另外直接開起來，
   * 接著就能寫；新資料夾則是選中它自己，因為下一步多半是往裡面放東西。
   */
  private promptCreate(folder: TFolder, body: HTMLElement, kind: "note" | "folder") {
    const app = this.host.app;
    const isNote = kind === "note";
    const where = this.folderLabel(folder);

    new NameModal(
      app,
      isNote ? `在「${where}」新增筆記` : `在「${where}」新增資料夾`,
      isNote ? "未命名" : "新資料夾",
      async (name) => {
        const dir = norm(folder.path);
        // 筆記一律補上 .md：這一區是寫作用的，要別的副檔名請用內建的檔案總管
        const leaf = isNote ? `${name}.md` : name;
        const path = dir ? `${dir}/${leaf}` : leaf;

        if (app.vault.getAbstractFileByPath(path)) {
          new Notice(`「${where}」裡已經有「${leaf}」了。`);
          return;
        }
        try {
          if (isNote) {
            const file = await app.vault.create(path, "");
            await app.workspace.getLeaf(false).openFile(file);
          } else {
            await app.vault.createFolder(path);
          }
        } catch (err) {
          new Notice(isNote ? "新增筆記失敗" : "新增資料夾失敗");
          return;
        }
        this.pick(isNote ? folder.path : path, body);
      }
    ).open();
  }

  private promptRename(file: TFile | TFolder) {
    const app = this.host.app;
    // .md 的副檔名不必每次重打；其他檔案連副檔名一起給，才有辦法改型別
    const isMd = file instanceof TFile && file.extension === "md";
    const initial = isMd ? (file as TFile).basename : file.name;

    new NameModal(app, `重新命名：${file.name}`, initial, async (name) => {
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

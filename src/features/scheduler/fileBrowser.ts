import { App, Keymap, Menu, Notice, TFile, TFolder, setIcon } from "obsidian";
import { ConfirmModal, RenameModal } from "./modals";
import type { FileSortKey, SchedulerSettings } from "./types";

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
 * - 麵包屑每一層可點，左上角箭頭回上層，★ 是常用資料夾快速跳轉，↑↓ 是排序
 * - 點資料夾進入、點檔案開啟（Ctrl／Cmd＋點開新分頁）
 * - .md 檔可拖到日期格子直接排程（其他檔案拖不動，沒有 frontmatter 可寫）
 * - 右鍵一律叫出 Obsidian 內建的檔案選單，不自己做重新命名／刪除
 *
 * 收合與篩選狀態存在實例上（跨重繪保留），目前所在資料夾與常用清單存設定，
 * 所以重開 Obsidian 還會停在原本那個資料夾。
 */
export class FileBrowser {
  /** 預設收合：月曆一打開的畫面要跟沒有這個功能時一模一樣 */
  private open = false;
  /** 篩選只對目前這一層有效，換資料夾就清掉 */
  private filter = "";

  constructor(private host: FileBrowserHost) {}

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

  /** 換資料夾時整塊重畫（工具列、篩選框、清單都會變） */
  private renderBody(body: HTMLElement) {
    body.empty();
    const folder = this.currentFolder();

    // 收起來的時候也看得出停在哪個資料夾
    const summary = body.parentElement?.querySelector<HTMLElement>("summary");
    if (summary) summary.setText(`檔案瀏覽（${folder.isRoot() ? "vault 根目錄" : folder.name}）`);

    // ===== 工具列：上一層 ← 麵包屑 → 常用資料夾 =====
    const bar = body.createDiv({ cls: "ht-fb-bar" });
    const up = bar.createEl("span", { cls: "ws-icon-btn", attr: { "aria-label": "回上一層" } });
    setIcon(up, "corner-left-up");
    if (folder.isRoot()) {
      up.addClass("ht-fb-disabled");
    } else {
      up.onclick = () => this.goTo(folder.parent?.path ?? "", body);
    }

    const crumbs = bar.createDiv({ cls: "ht-fb-crumbs" });
    const rootCrumb = crumbs.createSpan({ cls: "ht-fb-crumb", text: "vault" });
    if (folder.isRoot()) rootCrumb.addClass("ht-fb-crumb-current");
    else rootCrumb.onclick = () => this.goTo("", body);
    const parts = folder.isRoot() ? [] : folder.path.split("/");
    let acc = "";
    parts.forEach((part, i) => {
      crumbs.createSpan({ cls: "ht-fb-sep", text: "›" });
      acc = acc ? `${acc}/${part}` : part;
      const path = acc;
      const crumb = crumbs.createSpan({ cls: "ht-fb-crumb", text: part });
      if (i === parts.length - 1) crumb.addClass("ht-fb-crumb-current");
      else crumb.onclick = () => this.goTo(path, body);
    });

    const sort = bar.createEl("span", {
      cls: "ws-icon-btn ht-fb-sort",
      attr: { "aria-label": `排序：${this.sortLabel()}` },
    });
    setIcon(sort, "arrow-up-narrow-wide");
    sort.onclick = (e) => this.showSortMenu(e, body);

    const fav = bar.createEl("span", {
      cls: "ws-icon-btn ht-fb-fav",
      attr: { "aria-label": "常用資料夾" },
    });
    setIcon(fav, "star");
    fav.onclick = (e) => this.showFavMenu(e, body);

    // ===== 篩選（只濾目前這一層；打字時只重畫清單，輸入焦點不會掉） =====
    const filterRow = body.createDiv({ cls: "ht-fb-filter" });
    const input = filterRow.createEl("input", {
      type: "text",
      placeholder: "篩選這層…",
      value: this.filter,
    });

    const list = body.createDiv({ cls: "ht-fb-list" });
    input.addEventListener("input", () => {
      this.filter = input.value;
      this.renderList(list, folder, body);
    });

    this.renderList(list, folder, body);
  }

  private renderList(list: HTMLElement, folder: TFolder, body: HTMLElement) {
    list.empty();
    const q = this.filter.trim().toLowerCase();
    const match = (name: string) => !q || name.toLowerCase().includes(q);

    // 資料夾沒有 stat，排不了時間，一律照檔名排，只跟著目前的正／倒序走
    const dir = this.host.settings.fileBrowserSortAsc ? 1 : -1;
    const folders = folder.children
      .filter((c): c is TFolder => c instanceof TFolder)
      .filter((f) => match(f.name))
      .sort((a, b) => byName(a, b) * dir);
    const files = folder.children
      .filter((c): c is TFile => c instanceof TFile)
      .filter((f) => !this.host.settings.fileBrowserMdOnly || f.extension === "md")
      .filter((f) => match(f.name))
      .sort(this.fileComparator());

    if (folders.length === 0 && files.length === 0) {
      list.createSpan({
        cls: "ws-cal-hint",
        text: q ? "沒有符合的項目" : "這個資料夾是空的",
      });
      return;
    }

    for (const f of folders) {
      const row = list.createDiv({ cls: "ht-fb-row ht-fb-folder-row" });
      setIcon(row.createSpan({ cls: "ht-fb-icon" }), "folder");
      row.createSpan({ cls: "ht-fb-name", text: f.name });
      row.setAttr("title", f.path);
      row.onclick = () => this.goTo(f.path, body);
      row.addEventListener("contextmenu", (e) => this.showFileMenu(e, f));
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
    }
  }

  private currentFolder(): TFolder {
    const path = this.host.settings.fileBrowserFolder;
    const root = this.host.app.vault.getRoot();
    if (!path) return root;
    const f = this.host.app.vault.getAbstractFileByPath(path);
    // 資料夾可能已被改名或刪除：安靜退回根目錄，不要讓整個月曆跟著壞掉
    return f instanceof TFolder ? f : root;
  }

  private async goTo(path: string, body: HTMLElement) {
    this.host.settings.fileBrowserFolder = path;
    this.filter = "";
    await this.host.save();
    this.renderBody(body);
  }

  /** 目前排序方式的檔案比較函式 */
  private fileComparator(): (a: TFile, b: TFile) => number {
    const { fileBrowserSortKey: key, fileBrowserSortAsc: asc } = this.host.settings;
    const dir = asc ? 1 : -1;
    if (key === "name") return (a, b) => byName(a, b) * dir;
    const time = (f: TFile) => (key === "ctime" ? f.stat.ctime : f.stat.mtime);
    // 時間相同（同一批匯入、同一秒存檔）時退回檔名，順序才不會每次重畫都在跳
    return (a, b) => (time(a) - time(b)) * dir || byName(a, b);
  }

  /** 目前排序方式的說明文字，給按鈕的提示用 */
  private sortLabel(): string {
    const { fileBrowserSortKey: key, fileBrowserSortAsc: asc } = this.host.settings;
    const hit = SORT_OPTIONS.find((o) => o.key === key && o.asc === asc);
    return (hit ?? SORT_OPTIONS[0]).label;
  }

  private showSortMenu(e: MouseEvent, body: HTMLElement) {
    const menu = new Menu();
    const { fileBrowserSortKey: key, fileBrowserSortAsc: asc } = this.host.settings;
    SORT_OPTIONS.forEach((o, i) => {
      // 換一種依據就畫一條分隔線，三組（檔名／修改／建立）一眼分得開
      if (i > 0 && o.key !== SORT_OPTIONS[i - 1].key) menu.addSeparator();
      menu.addItem((it) =>
        it
          .setTitle(o.label)
          .setChecked(o.key === key && o.asc === asc)
          .onClick(async () => {
            this.host.settings.fileBrowserSortKey = o.key;
            this.host.settings.fileBrowserSortAsc = o.asc;
            await this.host.save();
            this.renderBody(body);
          })
      );
    });
    menu.showAtMouseEvent(e);
  }

  private showFavMenu(e: MouseEvent, body: HTMLElement) {
    const menu = new Menu();
    const favs = this.host.settings.favoriteFolders;
    const current = this.host.settings.fileBrowserFolder;

    if (favs.length === 0) {
      menu.addItem((i) => i.setTitle("尚未設定常用資料夾").setDisabled(true));
    }
    for (const p of favs) {
      menu.addItem((i) =>
        i
          .setTitle(p || "vault 根目錄")
          .setIcon("folder")
          .onClick(() => this.goTo(p, body))
      );
    }

    menu.addSeparator();
    const isFav = favs.includes(current);
    menu.addItem((i) =>
      i
        .setTitle(isFav ? "從常用移除目前資料夾" : "將目前資料夾加入常用")
        .setIcon(isFav ? "star-off" : "star")
        .onClick(async () => {
          this.host.settings.favoriteFolders = isFav
            ? favs.filter((p) => p !== current)
            : [...favs, current];
          await this.host.save();
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

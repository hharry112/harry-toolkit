import { TFile } from "obsidian";

/** 文章發佈狀態 */
export type PublishStatus = "idea" | "draft" | "scheduled" | "published";

export const STATUS_ORDER: PublishStatus[] = ["idea", "draft", "scheduled", "published"];

export const STATUS_LABEL: Record<PublishStatus, string> = {
  idea: "構想中",
  draft: "撰寫中",
  scheduled: "已排程",
  published: "已發佈",
};

/** 從 frontmatter 解析出來的一篇文章 */
export interface Article {
  file: TFile;
  status: PublishStatus;
  /** 預定發佈日 YYYY-MM-DD，可能未設定 */
  publishDate: string | null;
  /** 實際發佈日 YYYY-MM-DD */
  publishedDate: string | null;
  /** 平台標記，純文字 */
  platform: string | null;
}

/** Todo 檔中的一筆待辦 */
export interface TodoItem {
  /** 在 Todo 檔中的行號（0-based），作為操作依據 */
  line: number;
  text: string;
  done: boolean;
  /** 到期日 YYYY-MM-DD */
  dueDate: string | null;
}

/**
 * 月曆還沒開啟時，要把它開在哪裡。
 * 已經開著的月曆一律原地保留（使用者拖到側邊欄、分頁或獨立視窗都算數），
 * 這個設定只在「找不到既有月曆、要新開一個」時才用得到。
 */
export type CalendarLocation = "right" | "left" | "tab" | "window";

export const CALENDAR_LOCATION_LABEL: Record<CalendarLocation, string> = {
  right: "右側邊欄",
  left: "左側邊欄",
  tab: "主編輯區分頁",
  window: "獨立視窗",
};

/** 檔案瀏覽的排序依據 */
export type FileSortKey = "name" | "mtime" | "ctime";

export interface SchedulerSettings {
  /** 文章掃描資料夾，空字串 = 整個 vault */
  articleFolder: string;
  /** Todo 檔案路徑（vault 相對路徑） */
  todoFilePath: string;
  /** 是否啟用到期提醒 */
  reminderEnabled: boolean;
  /** 新開月曆時放的位置 */
  calendarLocation: CalendarLocation;
  /** 是否在月曆底部顯示「檔案瀏覽」收合區 */
  fileBrowserEnabled: boolean;
  /** 檔案瀏覽目前停留的資料夾（vault 相對路徑，空字串 = 根目錄） */
  fileBrowserFolder: string;
  /** 檔案瀏覽的常用資料夾清單（★ 選單用），空字串代表 vault 根目錄 */
  favoriteFolders: string[];
  /** 檔案瀏覽是否只列出 Markdown 檔 */
  fileBrowserMdOnly: boolean;
  /** 檔案瀏覽的排序依據：檔名／修改時間／建立日期 */
  fileBrowserSortKey: FileSortKey;
  /** 檔案瀏覽是否正序（檔名 A→Z；時間則是舊→新） */
  fileBrowserSortAsc: boolean;
}

export const DEFAULT_SETTINGS: SchedulerSettings = {
  articleFolder: "",
  todoFilePath: "Todo.md",
  reminderEnabled: true,
  calendarLocation: "right",
  fileBrowserEnabled: true,
  fileBrowserFolder: "",
  favoriteFolders: [],
  fileBrowserMdOnly: false,
  fileBrowserSortKey: "name",
  fileBrowserSortAsc: true,
};

/** 今天的 YYYY-MM-DD（本地時區） */
export function todayStr(): string {
  const d = new Date();
  return formatDate(d);
}

export function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 檢查是否為合法的 YYYY-MM-DD */
export function isValidDateStr(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00");
  return !isNaN(d.getTime()) && formatDate(d) === s;
}

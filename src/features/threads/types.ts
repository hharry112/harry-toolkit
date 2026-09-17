/**
 * Threads 數據功能的共用型別、預設值與小工具。
 *
 * 這個功能只讀資料、不發文，也不做任何需要瀏覽器自動化的事
 * （官方 API 沒提供的「單篇帶來多少新追蹤」就是沒有，不要想辦法繞）。
 */

/** 帳號層級 insights 的最早可查日期；Meta 規定更早的時間戳一律拒絕 */
export const EARLIEST_INSIGHT_DATE = "2024-04-13";

/** 面板還沒開啟時要開在哪裡（與 scheduler 的月曆同一套語意） */
export type PanelLocation = "right" | "left" | "tab" | "window";

export const PANEL_LOCATION_LABEL: Record<PanelLocation, string> = {
  right: "右側邊欄",
  left: "左側邊欄",
  tab: "主編輯區分頁",
  window: "獨立視窗",
};

/** 排行榜的排序依據 */
export type SortKey = "views" | "likes" | "replies" | "reposts" | "quotes" | "shares" | "date";

/** 鍵的順序就是下拉選單的順序；發佈時間放第一個，它是預設值 */
export const SORT_LABEL: Record<SortKey, string> = {
  date: "發佈時間",
  views: "瀏覽",
  likes: "讚",
  replies: "回覆",
  reposts: "轉發",
  quotes: "引用",
  shares: "分享",
};

/** 單篇貼文的成效數字。API 沒回的指標留 null，跟「真的是 0」分開。 */
export interface PostMetrics {
  views: number | null;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  quotes: number | null;
  shares: number | null;
}

export const EMPTY_METRICS: PostMetrics = {
  views: null,
  likes: null,
  replies: null,
  reposts: null,
  quotes: null,
  shares: null,
};

/** 存進 posts.json 的一篇貼文 */
export interface PostRecord {
  id: string;
  text: string;
  /** ISO 8601 發佈時間（API 原樣回傳的字串） */
  timestamp: string;
  permalink: string;
  mediaType: string;
  isReply: boolean;
  isQuotePost: boolean;
  metrics: PostMetrics;
  /** 最後一次抓到成效數字的時間（ISO 8601），沒抓過是 null */
  metricsAt: string | null;
}

/** 帳號層級的一天 */
export interface DayRecord {
  /** 追蹤人數。只能拿到「當下」的值，補不回來，所以每天要自己記一筆。 */
  followers: number | null;
  /** 帳號總瀏覽。API 本身就是每日序列，隨時可以回補。 */
  views: number | null;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  quotes: number | null;
}

/**
 * 資料檔是屬於哪個帳號的。
 * 第一次寫入時記下來，之後換了權杖要比對 —— 兩個帳號的資料混進同一個檔案，
 * 排行榜就整個沒有意義了。
 */
export interface FileOwner {
  accountId?: string;
  username?: string;
}

/** posts.json 的內容 */
export interface PostsFile extends FileOwner {
  version: number;
  updatedAt: string | null;
  posts: PostRecord[];
}

/** account-daily.json 的內容 */
export interface AccountFile extends FileOwner {
  version: number;
  /** key 是 YYYY-MM-DD */
  days: Record<string, DayRecord>;
}

export const DATA_VERSION = 1;

export function emptyPostsFile(): PostsFile {
  return { version: DATA_VERSION, updatedAt: null, posts: [] };
}

export function emptyAccountFile(): AccountFile {
  return { version: DATA_VERSION, days: {} };
}

export interface ThreadsSettings {
  /** Threads User Access Token（長效，60 天）。存在 data.json，是明文。 */
  accessToken: string;
  /** 連線成功後記下來的帳號資料，之後的呼叫都要用 userId */
  userId: string;
  username: string;
  /** 權杖到期時間（ISO 8601），刷新後會更新；不知道就是 null */
  tokenExpiresAt: string | null;
  /** 資料檔放哪個資料夾（vault 相對路徑），空字串 = vault 根目錄 */
  dataFolder: string;
  /** 「更新最近 N 天」用的天數 */
  recentDays: number;
  /** 面板還沒開時要開在哪 */
  panelLocation: PanelLocation;
  /** 是否每天自動記一筆帳號數據（追蹤數補不回來，預設開啟） */
  dailyAuto: boolean;
  /** 最後一次記錄每日帳號數據的日期 YYYY-MM-DD */
  lastDailyDate: string;
  /** 最後一次抓貼文的時間（ISO 8601） */
  lastSyncAt: string | null;
  /** 面板上次用的排序依據 */
  sortKey: SortKey;
  /** 排行榜是否把回覆也算進去（只影響顯示） */
  includeReplies: boolean;
  /**
   * 抓取時要不要連自己的回覆一起抓。
   * 回覆在另一支端點（me/replies），而且要 threads_read_replies 權限，
   * 篇數通常也比主貼文多很多、抓起來更久，所以獨立成一個開關。
   */
  fetchReplies: boolean;
}

export const DEFAULT_SETTINGS: ThreadsSettings = {
  accessToken: "",
  userId: "",
  username: "",
  tokenExpiresAt: null,
  dataFolder: "Threads 數據",
  recentDays: 30,
  panelLocation: "tab",
  dailyAuto: true,
  lastDailyDate: "",
  lastSyncAt: null,
  sortKey: "date",
  includeReplies: false,
  fetchReplies: false,
};

/** 本地時區的 YYYY-MM-DD（一律用字串比較日期，不要拿 Date 物件互比） */
export function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function todayStr(): string {
  return formatDate(new Date());
}

/** YYYY-MM-DD → 當地時間當天 00:00 的 Date */
export function parseDate(s: string): Date {
  const [y, m, d] = s.split("-").map((n) => Number(n));
  return new Date(y, (m || 1) - 1, d || 1);
}

export function addDays(s: string, n: number): string {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return formatDate(d);
}

/** 大數字加千分位；null 顯示成「—」 */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("zh-TW");
}

/** 貼文內文縮成一行預覽 */
export function previewText(text: string, max = 90): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (!oneLine) return "（無文字內容）";
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

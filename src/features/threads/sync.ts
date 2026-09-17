import { ThreadsApi, ThreadsApiError, readDailySeries, readMetricMap } from "./api";
import { ThreadsStore, mergeDay, mergePosts } from "./store";
import {
  AccountFile,
  EARLIEST_INSIGHT_DATE,
  PostRecord,
  ThreadsSettings,
  addDays,
  parseDate,
  todayStr,
} from "./types";

/**
 * 抓取流程。
 *
 * 這裡最重要的一件事：**貼文成效必須一篇一篇單獨問**，API 沒有批次版本。
 * 所以抓一次要跑幾分鐘，而且要節流（每篇之間停 180 毫秒，與 threads-analyzer
 * 實測可行的間隔一致），不然會被 Meta 擋。也因此一定要有進度與中斷。
 */

/** 每篇 insights 之間的間隔 */
const PER_POST_DELAY = 180;

/** 撞到頻率上限時先等這麼久再重試一次 */
const RATE_LIMIT_WAIT = 5000;

/** 回補歷史時一次問多長的區間；文件沒寫上限，分段純粹是保險 */
const BACKFILL_CHUNK_DAYS = 90;

export interface SyncProgress {
  /** 給使用者看的一句話 */
  message: string;
  current?: number;
  total?: number;
}

export interface SyncHandle {
  onProgress(p: SyncProgress): void;
  /** 回傳 true 代表使用者要求中斷 */
  cancelled(): boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export interface SyncResult {
  fetched: number;
  updated: number;
  failed: number;
  cancelled: boolean;
  /** 抓回覆失敗時的訊息（多半是權杖沒勾 threads_read_replies）；成功或沒抓是 null */
  replyError: string | null;
}

/**
 * 抓貼文與逐篇成效。
 *
 * `mode` 是 "recent" 時只處理最近 N 天發佈的貼文 —— 舊貼文的數字仍然留在檔案裡
 * （見 mergePosts），不會因為這輪沒問就被清空。
 */
export async function syncPosts(
  api: ThreadsApi,
  store: ThreadsStore,
  settings: ThreadsSettings,
  mode: "recent" | "all",
  handle: SyncHandle
): Promise<SyncResult> {
  const since =
    mode === "recent"
      ? parseDate(addDays(todayStr(), -Math.max(1, settings.recentDays)))
      : undefined;

  handle.onProgress({ message: "正在取得貼文清單…" });
  const fetched = await api.getPosts(settings.userId, {
    since,
    onPage: (count) => handle.onProgress({ message: `已取得 ${count} 篇貼文…` }),
    signal: () => handle.cancelled(),
  });

  // 回覆不在 me/threads 裡，要另外跟 me/replies 要，而且需要額外的權限，
  // 所以是可選的：失敗只回報訊息，不讓整輪抓取失敗。
  let replyError: string | null = null;
  if (settings.fetchReplies && !handle.cancelled()) {
    handle.onProgress({ message: "正在取得回覆清單…" });
    try {
      const replies = await api.getReplies(settings.userId, {
        since,
        onPage: (count) => handle.onProgress({ message: `已取得 ${count} 則回覆…` }),
        signal: () => handle.cancelled(),
      });
      fetched.push(...replies);
    } catch (e) {
      replyError = (e as Error).message;
    }
  }

  // Meta 不保證每個端點都尊重 since，自己再過濾一次
  const sinceMs = since?.getTime() ?? null;
  const targets = fetched.filter((p) => {
    if (sinceMs === null) return true;
    const t = new Date(p.timestamp).getTime();
    return Number.isNaN(t) ? true : t >= sinceMs;
  });

  let updated = 0;
  let failed = 0;
  let cancelled = false;

  for (let i = 0; i < targets.length; i++) {
    if (handle.cancelled()) {
      cancelled = true;
      break;
    }
    const post = targets[i];
    handle.onProgress({
      message: "正在讀取各篇成效…",
      current: i + 1,
      total: targets.length,
    });
    try {
      post.metrics = await fetchInsightsWithRetry(api, post.id);
      post.metricsAt = new Date().toISOString();
      updated++;
    } catch {
      // 單篇失敗不中斷整輪：可能是剛發佈還沒有數據，或那一篇被刪了
      failed++;
    }
    if (i < targets.length - 1) await sleep(PER_POST_DELAY);
  }

  const file = await store.loadPosts();
  file.posts = mergePosts(file.posts, targets);
  file.updatedAt = new Date().toISOString();
  file.accountId = settings.userId;
  file.username = settings.username;
  await store.savePosts(file);

  return { fetched: targets.length, updated, failed, cancelled, replyError };
}

async function fetchInsightsWithRetry(api: ThreadsApi, postId: string) {
  try {
    return await api.getPostInsights(postId);
  } catch (e) {
    if (e instanceof ThreadsApiError && (e.status === 429 || e.status >= 500)) {
      await sleep(RATE_LIMIT_WAIT);
      return await api.getPostInsights(postId);
    }
    throw e;
  }
}

/**
 * 記錄「今天」的帳號數據。
 *
 * 追蹤人數（followers_count）不吃 since／until，只拿得到當下的值，
 * **沒記就永遠補不回來**，所以這件事要每天做、而且要跟耗時的貼文抓取分開。
 * 它只有兩次 API 呼叫，不到一秒。
 *
 * followers_count 與其他指標分兩次問：它不支援時間區間，混在同一個請求裡會整包失敗。
 */
export async function recordToday(
  api: ThreadsApi,
  store: ThreadsStore,
  settings: ThreadsSettings
): Promise<void> {
  const today = todayStr();
  const file = await store.loadAccount();

  let followers: number | null = null;
  try {
    followers = await api.getFollowersCount(settings.userId);
  } catch {
    // 追蹤數拿不到就算了，下面的區間數據還是值得記
  }

  let daily: Record<string, number | null> = {};
  try {
    const json = await api.getAccountInsights(
      settings.userId,
      ["views", "likes", "replies", "reposts", "quotes"],
      parseDate(today),
      new Date()
    );
    // views 回的是每日序列，按它自己的 end_time 歸到對應的那一天
    // （Meta 的日界不是本地午夜，硬塞進「今天」會把跨日的量算錯）
    for (const point of readDailySeries(json, "views")) {
      mergeDay(file, point.date, { views: point.value });
    }
    // 其餘指標回的是整段區間的總和，就是今天到目前為止的累計
    daily = readMetricMap(json);
  } catch {
    daily = {};
  }

  mergeDay(file, today, {
    followers,
    likes: daily.likes ?? null,
    replies: daily.replies ?? null,
    reposts: daily.reposts ?? null,
    quotes: daily.quotes ?? null,
  });
  file.accountId = settings.userId;
  file.username = settings.username;
  await store.saveAccount(file);
}

/**
 * 回補帳號每日瀏覽數。
 *
 * `views` 是唯一一個本來就以「每日序列」回傳的帳號指標，所以中斷多久都補得回來，
 * 一次呼叫就能拿一整段。讚、回覆這些是區間總和，要逐日問才有每日值（一年就是
 * 365 次呼叫），價值不高，這裡不做 —— 它們從開始使用的那天起每天記一筆。
 *
 * 追蹤人數則是怎麼樣都補不回來的，只能靠 recordToday 每天累積。
 */
export async function backfillViews(
  api: ThreadsApi,
  store: ThreadsStore,
  settings: ThreadsSettings,
  handle: SyncHandle
): Promise<number> {
  const file = await store.loadAccount();
  const today = todayStr();
  const start = EARLIEST_INSIGHT_DATE;

  let filled = 0;
  let cursor = start;
  while (cursor <= today) {
    if (handle.cancelled()) break;
    const chunkEnd = minDate(addDays(cursor, BACKFILL_CHUNK_DAYS), today);
    handle.onProgress({ message: `正在回補 ${cursor} 至 ${chunkEnd} 的瀏覽數…` });
    try {
      const json = await api.getAccountInsights(
        settings.userId,
        ["views"],
        parseDate(cursor),
        // until 用當天的 23:59:59，避免最後一天被切掉
        new Date(parseDate(chunkEnd).getTime() + 86399000)
      );
      for (const point of readDailySeries(json, "views")) {
        mergeDay(file, point.date, { views: point.value });
        filled++;
      }
    } catch (e) {
      // 整段失敗就跳過這一段繼續下一段：早期資料 Meta 本來就標示「不保證正確」
      console.warn("[harry-toolkit] 回補瀏覽數失敗", cursor, chunkEnd, e);
    }
    if (chunkEnd === today) break;
    cursor = addDays(chunkEnd, 1);
  }

  await store.saveAccount(file);
  return filled;
}

function minDate(a: string, b: string): string {
  return a < b ? a : b;
}

/** 依排序鍵取出一篇貼文的數字，排序與顯示共用 */
export function metricOf(post: PostRecord, key: string): number {
  if (key === "date") return new Date(post.timestamp).getTime() || 0;
  // 回覆本身的回覆數 Meta 一律回 0，那是「沒有這項資料」不是真的 0；
  // 當成無值排在最後，才不會跟主貼文真正的 0 混在一起比較
  if (key === "replies" && post.isReply) return -1;
  const value = (post.metrics as unknown as Record<string, number | null>)[key];
  return value ?? -1;
}

/** 帳號檔裡最後一天有追蹤數的紀錄 */
export function latestFollowers(file: AccountFile): { date: string; value: number } | null {
  const dates = Object.keys(file.days).sort();
  for (let i = dates.length - 1; i >= 0; i--) {
    const value = file.days[dates[i]]?.followers;
    if (typeof value === "number") return { date: dates[i], value };
  }
  return null;
}

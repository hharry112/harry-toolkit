import { ThreadsApi, ThreadsApiError } from "./api";
import { ThreadsStore, mergePosts } from "./store";
import { PostRecord, ThreadsSettings, addDays, parseDate, todayStr } from "./types";

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

/** 依排序鍵取出一篇貼文的數字，排序與顯示共用 */
export function metricOf(post: PostRecord, key: string): number {
  if (key === "date") return new Date(post.timestamp).getTime() || 0;
  // 回覆本身的回覆數 Meta 一律回 0，那是「沒有這項資料」不是真的 0；
  // 當成無值排在最後，才不會跟主貼文真正的 0 混在一起比較
  if (key === "replies" && post.isReply) return -1;
  const value = (post.metrics as unknown as Record<string, number | null>)[key];
  return value ?? -1;
}

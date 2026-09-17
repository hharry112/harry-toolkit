import { requestUrl } from "obsidian";
import type { RequestUrlResponse } from "obsidian";
import { EMPTY_METRICS, PostMetrics, PostRecord } from "./types";

/**
 * Threads Graph API 的薄封裝。
 *
 * 用 Obsidian 的 `requestUrl` 而不是 `fetch`：插件跑在瀏覽器環境裡，
 * `fetch` 會被跨網域限制擋下來，`requestUrl` 是 Obsidian 專門提供來繞過這件事的。
 *
 * 一律帶 `throw: false` 自己判讀狀態碼，才有機會把 Meta 的錯誤訊息（它放在
 * 回應內容的 error.message，不是狀態碼）轉成看得懂的中文。
 */

const GRAPH_ROOT = "https://graph.threads.net/v1.0/";

/** 分頁的下一頁網址只接受這兩個網域，避免跟著回應裡的網址亂跑 */
const ALLOWED_HOSTS = new Set(["graph.threads.net", "graph.threads.com"]);

/** 貼文清單要的欄位 */
const POST_FIELDS = [
  "id",
  "media_product_type",
  "media_type",
  "permalink",
  "text",
  "timestamp",
  "shortcode",
  "is_quote_post",
  "is_reply",
].join(",");

/** 回覆多要幾個關聯欄位（是誰的串、回給誰） */
const REPLY_FIELDS = [POST_FIELDS, "has_replies", "root_post", "replied_to", "is_reply_owned_by_me"].join(
  ","
);

export class ThreadsApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: number) {
    super(message);
    this.name = "ThreadsApiError";
  }
}

/** 把訊息裡的權杖換成遮蔽字樣；錯誤訊息可能被貼進 issue 或截圖 */
function redact(message: string, token: string): string {
  let out = message;
  if (token) out = out.split(token).join("[已隱藏]");
  return out.replace(/(access_token|input_token)=[^&\s]+/gi, "$1=[已隱藏]");
}

/** 權限或權杖相關的錯誤代碼，給使用者的提示要不一樣 */
function friendlyMessage(status: number, code: number | undefined, raw: string): string {
  if (status === 401 || code === 190) {
    return `${raw}（權杖可能已失效或過期，請到設定頁重新貼一組）`;
  }
  if (code === 10 || code === 200 || status === 403) {
    return `${raw}（權限不足，產生權杖時要勾選 threads_basic 與 threads_manage_insights）`;
  }
  if (status === 429 || code === 4 || code === 17 || code === 32) {
    return `${raw}（已達 Meta 的呼叫頻率上限，等一下再試）`;
  }
  return raw;
}

export interface DayValue {
  /** YYYY-MM-DD（由 API 回傳的 end_time 轉成本地日期） */
  date: string;
  value: number;
}

export interface Profile {
  id: string;
  username: string;
  name: string | null;
}

export interface FetchOptions {
  /** 只抓這個時間之後發佈的 */
  since?: Date;
  /** 每翻一頁回報目前累計篇數 */
  onPage?: (count: number) => void;
  /** 回傳 true 代表使用者要求中斷 */
  signal?: () => boolean;
}

/**
 * 轉發外殼：你按轉發別人的貼文時，自己的清單裡會多出來的那個項目。
 * 沒有文字、沒有 permalink 內容，insights 全部回空 —— 不是資料，不要收。
 */
export function isRepostFacade(item: { media_type?: unknown; media_product_type?: unknown }): boolean {
  return item?.media_type === "REPOST_FACADE" || item?.media_product_type === "REPOST_FACADE";
}

/** 權杖少勾權限時 Meta 的回應：403，或錯誤碼 10 與 200～299 */
function isMissingPermission(error: ThreadsApiError): boolean {
  return (
    error.status === 403 ||
    error.code === 10 ||
    (error.code !== undefined && error.code >= 200 && error.code <= 299)
  );
}

export class ThreadsApi {
  constructor(private token: string) {}

  /** 送一個 GET 並回傳解析後的 JSON；非 2xx 一律轉成 ThreadsApiError */
  private async get(url: string): Promise<any> {
    let res: RequestUrlResponse;
    try {
      res = await requestUrl({ url, method: "GET", throw: false });
    } catch (e) {
      // 連不上（斷網、DNS、憑證）時 requestUrl 仍可能直接丟例外
      throw new ThreadsApiError(
        `無法連線到 Threads：${redact(String((e as Error)?.message ?? e), this.token)}`,
        0
      );
    }

    let body: any = null;
    try {
      body = res.json;
    } catch {
      body = null;
    }

    if (res.status >= 400) {
      const err = body?.error ?? {};
      const raw = typeof err.message === "string" ? err.message : `HTTP ${res.status}`;
      const code = typeof err.code === "number" ? err.code : undefined;
      throw new ThreadsApiError(
        redact(friendlyMessage(res.status, code, raw), this.token),
        res.status,
        code
      );
    }
    if (body === null) {
      throw new ThreadsApiError("Threads 回傳的內容不是有效的 JSON", res.status);
    }
    return body;
  }

  private url(path: string, params: Record<string, string | undefined>): string {
    const u = new URL(path, GRAPH_ROOT);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") u.searchParams.set(k, v);
    }
    u.searchParams.set("access_token", this.token);
    return u.toString();
  }

  /** 確認分頁網址沒被導去別的地方 */
  private static checkNext(next: string): string | null {
    try {
      const u = new URL(next);
      return u.protocol === "https:" && ALLOWED_HOSTS.has(u.hostname) ? next : null;
    } catch {
      return null;
    }
  }

  /** 取得目前權杖對應的帳號；也當作「測試連線」用 */
  async getProfile(): Promise<Profile> {
    const json = await this.get(
      this.url("me", { fields: "id,username,name,threads_profile_picture_url" })
    );
    const id = json?.id !== undefined ? String(json.id) : "";
    if (!id) throw new ThreadsApiError("Threads 沒有回傳帳號 id", 200);
    return {
      id,
      username: typeof json.username === "string" ? json.username : "",
      name: typeof json.name === "string" ? json.name : null,
    };
  }

  /**
   * 把長效權杖再延長 60 天。
   * Meta 規定權杖要建立滿 24 小時、尚未過期才能刷新，所以失敗是正常情況，
   * 呼叫端自己決定要不要理會。
   */
  async refreshToken(): Promise<{ token: string; expiresAt: string | null }> {
    const u = new URL("refresh_access_token", "https://graph.threads.net/");
    u.searchParams.set("grant_type", "th_refresh_token");
    u.searchParams.set("access_token", this.token);
    const json = await this.get(u.toString());
    const token = typeof json?.access_token === "string" ? json.access_token : "";
    if (!token) throw new ThreadsApiError("Threads 沒有回傳刷新後的權杖", 200);
    const seconds = typeof json.expires_in === "number" ? json.expires_in : null;
    const expiresAt =
      seconds === null ? null : new Date(Date.now() + seconds * 1000).toISOString();
    return { token, expiresAt };
  }

  /**
   * 取得主貼文清單（自動翻頁）。
   * `since` 有值時只抓那之後發佈的；Meta 不保證每個端點都尊重這個參數，
   * 所以呼叫端仍要自己再過濾一次。
   */
  getPosts(userId: string, options: FetchOptions = {}): Promise<PostRecord[]> {
    return this.fetchMedia(userId, "threads", POST_FIELDS, false, options);
  }

  /**
   * 取得自己發出的回覆。
   *
   * **回覆不在 `me/threads` 裡**，是另一支 `me/replies` 端點，而且要多一個
   * `threads_read_replies` 權限 —— 權杖沒勾這項時 Meta 會回 403 或錯誤碼 10。
   */
  async getReplies(userId: string, options: FetchOptions = {}): Promise<PostRecord[]> {
    try {
      return await this.fetchMedia(userId, "replies", REPLY_FIELDS, true, options);
    } catch (e) {
      if (e instanceof ThreadsApiError && isMissingPermission(e)) {
        throw new ThreadsApiError(
          "讀取回覆需要 threads_read_replies 權限。請回 Meta 開發者後台重新產生權杖，" +
            "產生時把這一項一起勾起來，再回設定頁貼上並重新測試連線。",
          e.status,
          e.code
        );
      }
      throw e;
    }
  }

  private async fetchMedia(
    userId: string,
    edge: "threads" | "replies",
    fields: string,
    isReply: boolean,
    options: FetchOptions
  ): Promise<PostRecord[]> {
    let next: string | null = this.url(`${encodeURIComponent(userId)}/${edge}`, {
      fields,
      limit: "100",
      since: options.since ? String(Math.floor(options.since.getTime() / 1000)) : undefined,
    });

    const posts: PostRecord[] = [];
    let pages = 0;
    // 上限 100 頁 × 100 篇：正常帳號遠遠用不到，純粹避免回應異常時無限翻頁
    while (next && pages < 100) {
      if (options.signal?.()) break;
      const json: any = await this.get(next);
      const data = Array.isArray(json?.data) ? json.data : [];
      for (const item of data) {
        const id = item?.id !== undefined ? String(item.id) : "";
        const timestamp = typeof item?.timestamp === "string" ? item.timestamp : "";
        if (!id || !timestamp) continue;
        // 轉發別人貼文時 Threads 會產生一個沒有內容的空殼，成效一律是空的。
        // 收進來只會佔清單版面，還害每輪抓取多打幾百次沒有意義的 insights。
        if (isRepostFacade(item)) continue;
        posts.push({
          id,
          text: typeof item.text === "string" ? item.text : "",
          timestamp,
          permalink: typeof item.permalink === "string" ? item.permalink : "",
          mediaType: typeof item.media_type === "string" ? item.media_type : "TEXT_POST",
          // 從 replies 端點來的一律算回覆：這支端點回的東西不一定帶 is_reply 欄位
          isReply: isReply || item.is_reply === true,
          isQuotePost: item.is_quote_post === true,
          metrics: { ...EMPTY_METRICS },
          metricsAt: null,
        });
      }
      pages++;
      options.onPage?.(posts.length);
      const raw = typeof json?.paging?.next === "string" ? json.paging.next : null;
      next = raw ? ThreadsApi.checkNext(raw) : null;
    }
    return posts;
  }

  /**
   * 取得單篇貼文的成效。
   *
   * `shares` 不是每個帳號都有，缺它的時候 Meta 會回 400；
   * 這時去掉 shares 再問一次（threads-analyzer 踩過同一個雷）。
   */
  async getPostInsights(postId: string): Promise<PostMetrics> {
    const full = ["views", "likes", "replies", "reposts", "quotes", "shares"];
    let json: any;
    try {
      json = await this.getInsights(postId, full);
    } catch (e) {
      if (e instanceof ThreadsApiError && e.status === 400) {
        json = await this.getInsights(postId, full.slice(0, 5));
      } else {
        throw e;
      }
    }
    const values = readMetricMap(json);
    return {
      views: values.views ?? null,
      likes: values.likes ?? null,
      replies: values.replies ?? null,
      reposts: values.reposts ?? null,
      quotes: values.quotes ?? null,
      shares: values.shares ?? null,
    };
  }

  private getInsights(id: string, metrics: string[]): Promise<any> {
    return this.get(
      this.url(`${encodeURIComponent(id)}/insights`, { metric: metrics.join(",") })
    );
  }

  /**
   * 帳號層級的區間數據。
   * `views` 回的是每日序列，其餘（讚、回覆、轉發、引用）是整段區間的總和。
   */
  async getAccountInsights(
    userId: string,
    metrics: string[],
    since?: Date,
    until?: Date
  ): Promise<any> {
    return this.get(
      this.url(`${encodeURIComponent(userId)}/threads_insights`, {
        metric: metrics.join(","),
        since: since ? String(Math.floor(since.getTime() / 1000)) : undefined,
        until: until ? String(Math.floor(until.getTime() / 1000)) : undefined,
      })
    );
  }

  /** 目前的追蹤人數。這個指標不吃 since／until，只拿得到「現在」。 */
  async getFollowersCount(userId: string): Promise<number | null> {
    const json = await this.getAccountInsights(userId, ["followers_count"]);
    return readMetricMap(json).followers_count ?? null;
  }

}

/** 把 `>= 0` 的整數挑出來；型別不對或負數一律視為沒有值 */
function toCount(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

/**
 * 從 insights 回應裡讀出「一個指標一個數字」。
 *
 * 同一支端點有兩種格式：帳號層級的總和放在 `total_value.value`，
 * 單篇成效與每日序列放在 `values[]`。先看 total_value 再看 values，
 * 兩種都要吃（這是 threads-analyzer 實測出來的順序）。
 */
function readMetricMap(json: any): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  const data = Array.isArray(json?.data) ? json.data : [];
  for (const metric of data) {
    const name = typeof metric?.name === "string" ? metric.name : "";
    if (!name) continue;
    if (metric?.total_value && typeof metric.total_value === "object") {
      out[name] = toCount(metric.total_value.value);
      continue;
    }
    if (Array.isArray(metric?.values) && metric.values.length > 0) {
      // 多筆（每日序列）時取總和，單筆時就是它自己
      let sum = 0;
      let seen = false;
      for (const v of metric.values) {
        const n = toCount(v?.value);
        if (n !== null) {
          sum += n;
          seen = true;
        }
      }
      out[name] = seen ? sum : null;
    }
  }
  return out;
}

/** 從 insights 回應裡讀出某個指標的每日序列（目前只有 views 是這種格式） */
export function readDailySeries(json: any, name: string): DayValue[] {
  const data = Array.isArray(json?.data) ? json.data : [];
  const metric = data.find((m: any) => m?.name === name);
  const values = Array.isArray(metric?.values) ? metric.values : [];
  const out: DayValue[] = [];
  for (const v of values) {
    const n = toCount(v?.value);
    const endTime = typeof v?.end_time === "string" ? v.end_time : "";
    if (n === null || !endTime) continue;
    const d = new Date(endTime);
    if (Number.isNaN(d.getTime())) continue;
    // end_time 是該統計日的結束時刻，換算成本地日期字串
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    out.push({ date: `${y}-${m}-${day}`, value: n });
  }
  return out;
}

export { readMetricMap };

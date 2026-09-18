import { App, normalizePath } from "obsidian";
import { DATA_VERSION, PostRecord, PostsFile, emptyPostsFile } from "./types";

/**
 * 資料檔的讀寫。
 *
 * 檔案放在使用者 vault 裡（不是插件資料夾），理由是這批數字有長期價值：
 * 抓一次要跑好幾分鐘，不該跟著插件一起被刪掉。
 * 停用或移除插件後，posts.json 仍然留在 vault 裡。
 *
 * 用 `vault.adapter` 直接讀寫而不是 `vault.create/modify`：這是資料檔不是筆記，
 * 不需要 TFile，也不必驚動 Obsidian 的檔案快取與 vault 事件
 * （月曆那邊監聽著 create／delete，少吵它一次是一次）。
 */

const POSTS_FILE = "posts.json";

export class ThreadsStore {
  constructor(private app: App, private folder: () => string) {}

  /** 資料檔的完整路徑；資料夾設定是空字串時放 vault 根目錄 */
  private path(name: string): string {
    const folder = this.folder().trim().replace(/^\/+|\/+$/g, "");
    return normalizePath(folder ? `${folder}/${name}` : name);
  }

  get postsPath(): string {
    return this.path(POSTS_FILE);
  }

  /** 逐層建立資料夾：使用者可能填 `數據/Threads` 這種多層路徑，中間那層不一定存在 */
  private async ensureFolder(): Promise<void> {
    const folder = this.folder().trim().replace(/^\/+|\/+$/g, "");
    if (!folder) return;
    const parts = normalizePath(folder).split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(current))) {
        await this.app.vault.adapter.mkdir(current);
      }
    }
  }

  /**
   * 讀一個 JSON 檔。檔案不存在就給空資料；
   * **內容壞掉時直接拋錯，不會當成空的**：靜默覆蓋等於把使用者累積的資料清掉。
   */
  private async readJson<T>(path: string, fallback: () => T): Promise<T> {
    if (!(await this.app.vault.adapter.exists(path))) return fallback();
    const raw = await this.app.vault.adapter.read(path);
    if (!raw.trim()) return fallback();
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new Error(
        `資料檔內容無法解析：${path}。請先備份並修正（或刪除）這個檔案，再重新抓取。`
      );
    }
  }

  private async writeJson(path: string, data: unknown): Promise<void> {
    await this.ensureFolder();
    await this.app.vault.adapter.write(path, JSON.stringify(data, null, 2));
  }

  async loadPosts(): Promise<PostsFile> {
    const file = await this.readJson<PostsFile>(this.postsPath, emptyPostsFile);
    return {
      version: typeof file.version === "number" ? file.version : DATA_VERSION,
      updatedAt: typeof file.updatedAt === "string" ? file.updatedAt : null,
      posts: Array.isArray(file.posts) ? file.posts : [],
      accountId: typeof file.accountId === "string" ? file.accountId : undefined,
      username: typeof file.username === "string" ? file.username : undefined,
    };
  }

  /**
   * 檢查資料檔原本屬於哪個帳號。
   *
   * 回傳非 null 代表現在這組權杖對應的帳號跟檔案裡記的不一樣 ——
   * 直接抓下去會把兩個帳號的貼文混在同一個檔案裡，呼叫端要先問過使用者。
   * 檔案還沒有帳號記錄（舊版存的）時一律視為相符，不打擾既有使用者。
   */
  async accountConflict(userId: string): Promise<{ accountId: string; username: string } | null> {
    if (!userId) return null;
    try {
      const file = await this.loadPosts();
      if (!file.accountId || file.accountId === userId) return null;
      return { accountId: file.accountId, username: file.username ?? "（未記錄名稱）" };
    } catch {
      // 檔案讀不出來是另一回事，交給抓取流程自己去報錯
      return null;
    }
  }

  async savePosts(file: PostsFile): Promise<void> {
    await this.writeJson(this.postsPath, file);
  }

}

/**
 * 把新抓到的貼文併進既有清單。
 *
 * 以貼文 id 為準；**這次沒抓到成效的貼文要保留舊數字**（例如只更新最近 30 天時，
 * 更早的貼文根本沒被問過 insights，不能因此把它們的數字清成空白）。
 */
export function mergePosts(existing: PostRecord[], incoming: PostRecord[]): PostRecord[] {
  const byId = new Map<string, PostRecord>();
  // 順手清掉舊版收進來的轉發外殼（沒有內容也沒有數據的空項目）。
  // 這是唯一會從檔案裡消失的東西，其餘一律只增不減。
  for (const post of existing) {
    if (post.mediaType === "REPOST_FACADE") continue;
    byId.set(post.id, post);
  }

  for (const post of incoming) {
    const old = byId.get(post.id);
    if (!old) {
      byId.set(post.id, post);
      continue;
    }
    byId.set(post.id, {
      ...post,
      // 沒抓成效的這一輪（metricsAt 是 null）沿用舊值
      metrics: post.metricsAt ? post.metrics : old.metrics,
      metricsAt: post.metricsAt ?? old.metricsAt,
    });
  }

  // 新到舊排序，存檔內容對人也好讀
  return [...byId.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}


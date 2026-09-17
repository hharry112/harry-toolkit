import type { App } from "obsidian";
import { ThreadsApi } from "./api";
import type { ThreadsStore } from "./store";
import type { SyncHandle, SyncProgress } from "./sync";
import type { ThreadsSettings } from "./types";

/**
 * 功能內部共用的環境，取代對根插件類別的依賴（與 scheduler 的 context.ts 同樣用意）。
 */
export interface ThreadsContext {
  app: App;
  /** 活的設定參考，改完直接呼叫 save() */
  settings: ThreadsSettings;
  save(): Promise<void>;
  store: ThreadsStore;
  /** 還沒設定權杖時回傳 null */
  api(): ThreadsApi | null;
  runner: SyncRunner;
}

/**
 * 抓取的統一入口。
 *
 * 存在的理由有兩個：抓一次要跑好幾分鐘，**同一時間只能有一件在跑**
 * （兩邊同時打 API 會直接撞上頻率上限）；而且面板、指令、設定頁都要看得到
 * 同一份進度，所以進度用訂閱的方式廣播出去。
 */
export class SyncRunner {
  private running = false;
  private cancelFlag = false;
  private current: SyncProgress | null = null;
  private listeners = new Set<(p: SyncProgress | null) => void>();

  get isRunning(): boolean {
    return this.running;
  }

  get progress(): SyncProgress | null {
    return this.current;
  }

  /** 請求中斷；正在跑的工作會在下一個檢查點停下來 */
  cancel(): void {
    if (this.running) this.cancelFlag = true;
  }

  subscribe(fn: (p: SyncProgress | null) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(p: SyncProgress | null) {
    this.current = p;
    for (const fn of this.listeners) {
      try {
        fn(p);
      } catch (e) {
        console.error("[harry-toolkit] Threads 進度通知失敗", e);
      }
    }
  }

  /**
   * 跑一件抓取工作。已經有工作在跑時回傳 false，呼叫端自己決定要不要提示。
   * 不論成功失敗都保證把 running 放掉，否則之後永遠抓不了。
   */
  async run<T>(task: (handle: SyncHandle) => Promise<T>): Promise<{ ok: boolean; result?: T }> {
    if (this.running) return { ok: false };
    this.running = true;
    this.cancelFlag = false;
    const handle: SyncHandle = {
      onProgress: (p) => this.emit(p),
      cancelled: () => this.cancelFlag,
    };
    try {
      const result = await task(handle);
      return { ok: true, result };
    } finally {
      this.running = false;
      this.cancelFlag = false;
      this.emit(null);
    }
  }
}

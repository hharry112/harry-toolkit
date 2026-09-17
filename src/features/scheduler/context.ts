import type { App, Plugin } from "obsidian";
import type { TodoStore } from "./todoStore";
import type { SchedulerSettings } from "./types";

/**
 * 發佈排程功能內部共用的執行環境。
 *
 * 取代舊版的 `import type WriterSchedulerPlugin from "./main"`：
 * 檢視與提醒服務只依賴這個介面，不知道也不需要知道根插件類別是誰。
 */
export interface SchedulerContext {
  app: App;
  /** 註冊指令／檢視／事件／interval 用 */
  plugin: Plugin;
  /** 本功能的設定區塊（活的參考） */
  readonly settings: SchedulerSettings;
  save(): Promise<void>;
  todoStore: TodoStore;
  /** 開啟月曆；已經開著就顯示既有的那個，不會搬動它的位置 */
  activateCalendar(): Promise<void>;
}

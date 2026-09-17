import type { App, Plugin } from "obsidian";

/**
 * 交給功能模組的執行環境。
 *
 * plugin 只用 Obsidian 的基底型別 `Plugin`，功能模組因此不需要（也不可以）
 * import 根插件類別 —— 這是模組制能成立的關鍵：功能與進入點之間沒有循環依賴，
 * 新增或搬移功能都不必動到 `main.ts`。
 */
export interface FeatureContext<S> {
	app: App;
	/** 註冊指令／檢視／事件／interval 用；Obsidian 會在插件卸載時自動清理 */
	plugin: Plugin;
	/** 這個功能自己的設定區塊（活的參考，直接改再呼叫 save()） */
	readonly settings: S;
	save(): Promise<void>;
}

export interface Feature<S = any> {
	/** 設定檔中的 key，例如 "scroll"。決定資料結構，訂了就不要改。 */
	id: string;
	/** 設定頁的區塊標題，例如 "捲動" */
	name: string;
	/** 設定頁區塊標題底下的一行說明 */
	description?: string;
	/** 這個功能的預設設定（不含 enabled，由 core 統一加） */
	defaults: S;
	onload(ctx: FeatureContext<S>): void | Promise<void>;
	/** 設定頁區塊內容；沒有可設定項就不用實作 */
	buildSettings?(containerEl: HTMLElement, ctx: FeatureContext<S>): void;
}

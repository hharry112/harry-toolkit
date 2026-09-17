import { Notice, Plugin } from "obsidian";
import type { Feature, FeatureContext } from "./core/feature";
import type { ToolkitSettings } from "./core/settings";
import { normalizeSettings } from "./core/settings";
import { ToolkitSettingTab } from "./core/settingsTab";
import { FEATURES } from "./features";

/**
 * 插件進入點。這裡只做三件事：讀設定、逐一載入啟用的功能、掛上總設定頁。
 * 任何功能專屬的邏輯都不該寫在這個檔案裡。
 */
export default class HarryToolkitPlugin extends Plugin {
	settings!: ToolkitSettings;

	async onload() {
		await this.loadSettings();

		for (const feature of FEATURES) {
			if (!this.settings.features[feature.id]?.enabled) continue;
			// 逐一 try/catch：單一功能載入失敗時，其他功能照常運作
			try {
				await feature.onload(this.contextFor(feature));
			} catch (e) {
				console.error(`[harry-toolkit] 功能 ${feature.id} 載入失敗`, e);
				new Notice(`Harry Toolkit：「${feature.name}」載入失敗，其他功能不受影響。`);
			}
		}

		this.addSettingTab(new ToolkitSettingTab(this.app, this, FEATURES));
	}

	/** 產生交給功能模組的執行環境；settings 是活的參考，功能改完直接呼叫 save() */
	contextFor<S>(feature: Feature<S>): FeatureContext<S> {
		return {
			app: this.app,
			plugin: this,
			settings: this.settings.features[feature.id] as unknown as S,
			save: () => this.saveSettings(),
		};
	}

	async loadSettings() {
		this.settings = normalizeSettings(await this.loadData(), FEATURES);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

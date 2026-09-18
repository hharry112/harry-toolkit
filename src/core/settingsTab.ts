import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type { Plugin } from "obsidian";
import type { Feature, FeatureContext } from "./feature";
import type { ToolkitSettings } from "./settings";

/**
 * 設定頁需要的根插件能力。用介面描述而不是 import 根類別，
 * 避免 `main.ts` 與 core 互相 import。
 */
export interface ToolkitHost extends Plugin {
	settings: ToolkitSettings;
	saveSettings(): Promise<void>;
	contextFor<S>(feature: Feature<S>): FeatureContext<S>;
}

/** 提示文字：功能開關與註冊（指令、檢視、事件）綁在插件生命週期上，不會即時生效 */
const RELOAD_HINT =
	"已儲存。功能開關要重新載入插件才會生效：到「設定 → 社群插件」把 Harry Toolkit 關掉再開啟，或按 Ctrl+R 重新載入 Obsidian。";

/** 總設定頁：每個功能一個區塊，區塊第一項固定是啟用開關 */
export class ToolkitSettingTab extends PluginSettingTab {
	constructor(app: App, private host: ToolkitHost, private features: Feature[]) {
		super(app, host);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		for (const feature of this.features) {
			const state = this.host.settings.features[feature.id];
			if (!state) continue;

			// 每個功能一個明顯的分段標題：設定頁一路往下滾都是灰白的設定列，
			// 沒有強調的話看不出「這裡換成另一個功能了」（樣式見 styles.css 的 ht-feature-heading）
			const heading = new Setting(containerEl).setName(feature.name).setHeading();
			heading.settingEl.addClass("ht-feature-heading");
			if (feature.description) heading.setDesc(feature.description);

			new Setting(containerEl)
				.setName("啟用此功能")
				.setDesc("關閉後這個功能的指令與檢視都會消失，其他功能不受影響。需重新載入插件才生效。")
				.addToggle((t) =>
					t.setValue(state.enabled !== false).onChange(async (v) => {
						state.enabled = v;
						await this.host.saveSettings();
						new Notice(RELOAD_HINT, 10000);
					})
				);

			// 功能自己的設定項不論啟用與否都顯示，方便先調好再啟用
			feature.buildSettings?.(containerEl, this.host.contextFor(feature));
		}

		if (this.features.length === 0) {
			containerEl.createEl("p", { text: "目前沒有任何功能模組。" });
		}
	}
}

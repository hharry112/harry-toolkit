import type { Feature } from "./feature";

/** 一個功能的設定區塊：固定有 enabled，其餘欄位由各功能自己定義 */
export interface FeatureState {
	enabled: boolean;
	[key: string]: unknown;
}

export interface ToolkitSettings {
	/** 資料結構版本。目前用不到，將來要改結構時才有判斷依據。 */
	version: number;
	/** key 是 Feature.id */
	features: Record<string, FeatureState>;
}

export const SETTINGS_VERSION = 1;

/**
 * 把 `data.json` 的內容整理成完整的設定物件。
 *
 * 每個功能都做一次 `{ enabled: true } → 預設值 → 存檔值` 的疊加，
 * 所以新增功能、或替既有功能新增欄位時，舊的 `data.json` 都不會壞：
 * 缺的欄位自動補上預設值，多的欄位原樣留著（不會被吃掉）。
 */
export function normalizeSettings(raw: unknown, features: Feature[]): ToolkitSettings {
	const saved = (raw ?? {}) as Partial<ToolkitSettings>;
	const savedFeatures = (saved.features ?? {}) as Record<string, unknown>;
	const features_: Record<string, FeatureState> = {};

	for (const f of features) {
		features_[f.id] = Object.assign(
			{ enabled: true },
			f.defaults,
			savedFeatures[f.id] ?? {}
		) as FeatureState;
	}

	// 保留不在清單中的區塊：功能暫時被拿掉時，使用者的設定不會被清空
	for (const id of Object.keys(savedFeatures)) {
		if (!(id in features_)) {
			features_[id] = savedFeatures[id] as FeatureState;
		}
	}

	return {
		version: typeof saved.version === "number" ? saved.version : SETTINGS_VERSION,
		features: features_,
	};
}

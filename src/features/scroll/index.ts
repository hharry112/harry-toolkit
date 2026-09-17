import { Editor, Setting } from "obsidian";
import { EditorSelection } from "@codemirror/state";
import type { SelectionRange } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { Feature, FeatureContext } from "../../core/feature";

export interface ScrollSettings {
	/** 按一次快捷鍵捲動的行數 */
	lines: number;
	/** 是否使用平滑捲動動畫 */
	smooth: boolean;
}

/** 量一個游標位置在畫面上的上緣 y 座標；位置沒被算繪出來時回傳 null */
function topOf(view: EditorView, range: SelectionRange): number | null {
	// assoc 決定折行處的位置算在上一個視覺行的行尾還是下一個的行首，
	// 用 moveVertically 自己的慣例（0 視為 -1）才會跟它算出來的行一致
	return view.coordsAtPos(range.head, range.assoc || -1)?.top ?? null;
}

/**
 * 把游標往 direction 方向移動 N 個視覺行，畫面同時捲動「游標實際移動的像素」，
 * 兩者抵消後游標固定在畫面上的同一個位置（例如一直停在畫面中間），
 * 內容則從游標底下流過。direction 為 1 時內容上移，-1 時內容下移。
 *
 * 游標移動用 moveVertically 以「折行後的視覺行」計算，長段落折行時
 * 位置依然正確；連續按時的目標欄位（goalColumn）也會保留，
 * 游標不會因為經過短行而漂移。
 *
 * 捲動距離一定要用 coordsAtPos 實際量，不能用 `行數 × defaultLineHeight` 估算，
 * 否則按住不放時游標會在畫面上慢慢漂移，原因有二：
 *  1. moveVertically 往下移是從「目前行的底部」起算、往上移是從「頂部」起算，
 *     同樣傳一個行高，往下會多跨一整行，本身就不對稱。
 *  2. defaultLineHeight 是 CodeMirror 依字型算的預設行高，與 Obsidian 實際的
 *     行距（段落間距、標題、圖片）不一致。
 */
function scroll(editor: Editor, direction: 1 | -1, settings: ScrollSettings) {
	const view = (editor as unknown as { cm?: EditorView }).cm;
	if (!view) return;
	const forward = direction > 0;
	const lines = Math.max(1, settings.lines);

	// 不帶距離參數呼叫時，moveVertically 正好移動一個視覺行；要移 N 行就呼叫 N 次。
	// 回傳的 range 帶著 goalColumn，一路傳下去游標才不會被中間的短行帶偏。
	const start = view.state.selection.main;
	let moved = start;
	for (let i = 0; i < lines; i++) {
		const next = view.moveVertically(moved, forward);
		if (next.head === moved.head) break; // 已到文件開頭／結尾
		moved = next;
	}

	// 游標動不了（文件開頭／結尾）或位置量不到時，退回用估算值捲，
	// 讓畫面照樣捲得動，游標自然停在第一行或最後一行
	let delta = direction * lines * view.defaultLineHeight;
	if (moved.head !== start.head) {
		// 只改選取範圍不會改變任何位置的座標，所以兩次量測都在 dispatch 前做，
		// 不必等版面重算
		const from = topOf(view, start);
		const to = topOf(view, moved);
		if (from !== null && to !== null) delta = to - from;
		view.dispatch({ selection: EditorSelection.create([moved]) });
	}

	if (settings.smooth) {
		view.scrollDOM.scrollBy({ top: delta, behavior: "smooth" });
	} else {
		view.scrollDOM.scrollTop += delta;
	}
}

export const scrollFeature: Feature<ScrollSettings> = {
	id: "scroll",
	name: "捲動",
	description: "用快捷鍵捲動內容，游標固定停在畫面上的同一個位置。",
	defaults: {
		lines: 1,
		smooth: false,
	},

	onload(ctx: FeatureContext<ScrollSettings>) {
		// repeatable: true 一定要留著，否則按住快捷鍵不放只會觸發一次
		ctx.plugin.addCommand({
			id: "scroll-down-keep-cursor",
			name: "內容上移（游標固定在畫面原位）",
			repeatable: true,
			editorCallback: (editor) => scroll(editor, 1, ctx.settings),
		});

		ctx.plugin.addCommand({
			id: "scroll-up-keep-cursor",
			name: "內容下移（游標固定在畫面原位）",
			repeatable: true,
			editorCallback: (editor) => scroll(editor, -1, ctx.settings),
		});
	},

	buildSettings(containerEl: HTMLElement, ctx: FeatureContext<ScrollSettings>) {
		new Setting(containerEl)
			.setName("每次捲動行數")
			.setDesc("按一次快捷鍵捲動幾行。")
			.addSlider((slider) =>
				slider
					.setLimits(1, 20, 1)
					.setValue(ctx.settings.lines)
					.setDynamicTooltip()
					.onChange(async (value) => {
						ctx.settings.lines = value;
						await ctx.save();
					})
			);

		new Setting(containerEl)
			.setName("平滑捲動")
			.setDesc("捲動時帶滑順動畫；需要快速連按捲動時建議關閉。")
			.addToggle((toggle) =>
				toggle.setValue(ctx.settings.smooth).onChange(async (value) => {
					ctx.settings.smooth = value;
					await ctx.save();
				})
			);
	},
};

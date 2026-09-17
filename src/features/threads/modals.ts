import { App, Modal, Setting } from "obsidian";
import type { ThreadsContext } from "./context";

/**
 * 是非題確認，回傳 Promise 方便在流程中 `await`。
 *
 * 不從 scheduler 借用同名的對話框：功能模組之間不互相 import，
 * 兩邊要各自獨立（scheduler 哪天被拿掉，這裡不能跟著壞）。
 */
class ConfirmModal extends Modal {
  private answered = false;

  constructor(
    app: App,
    private title: string,
    private lines: string[],
    private confirmText: string,
    private warning: boolean,
    private resolve: (ok: boolean) => void
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    this.setTitle(this.title);
    for (const line of this.lines) {
      contentEl.createEl("p", { text: line });
    }

    new Setting(contentEl)
      .addButton((b) => {
        b.setButtonText(this.confirmText).onClick(() => {
          this.answered = true;
          this.resolve(true);
          this.close();
        });
        if (this.warning) b.setWarning();
        else b.setCta();
      })
      .addButton((b) => b.setButtonText("取消").onClick(() => this.close()));
  }

  onClose() {
    this.contentEl.empty();
    // 按 Esc 或點外面關掉也算取消，不能讓呼叫端的 await 永遠卡住
    if (!this.answered) this.resolve(false);
  }
}

export function confirm(
  app: App,
  title: string,
  lines: string[],
  confirmText: string,
  warning = false
): Promise<boolean> {
  return new Promise((resolve) => {
    new ConfirmModal(app, title, lines, confirmText, warning, resolve).open();
  });
}

/** 每篇貼文的成效要單獨問一次，抓一篇大約要這麼久（含節流與網路往返） */
const SECONDS_PER_POST = 0.5;

function humanDuration(posts: number): string {
  const minutes = Math.round((posts * SECONDS_PER_POST) / 60);
  if (minutes < 1) return "不到一分鐘";
  if (minutes < 60) return `大約 ${minutes} 分鐘`;
  return `大約 ${Math.round((minutes / 60) * 10) / 10} 小時`;
}

/**
 * 抓取前的關卡。兩種情況要先問過使用者：
 *  1. 「全部重抓」會跑很久，誤按的代價不小
 *  2. 資料檔原本屬於別的帳號 —— 混在一起排行榜就沒意義了
 *
 * 沒有這兩種情況（日常的「更新最近貼文」）就直接放行，不要拿對話框煩人。
 */
export async function confirmBeforeSync(
  ctx: ThreadsContext,
  mode: "recent" | "all"
): Promise<boolean> {
  const conflict = await ctx.store.accountConflict(ctx.settings.userId);
  if (conflict) {
    const ok = await confirm(
      ctx.app,
      "這份資料屬於另一個帳號",
      [
        `資料檔裡記錄的帳號是 @${conflict.username}，但目前權杖對應的是 @${ctx.settings.username}。`,
        "繼續抓取會把兩個帳號的貼文合併在同一個檔案裡，排行榜會混在一起。",
        "如果你只是在同一個帳號上換了一組權杖，繼續即可。" +
          "如果真的換了帳號，請先到設定改用另一個資料資料夾，或把現有的 posts.json 移走。",
        `資料夾：${ctx.settings.dataFolder || "（vault 根目錄）"}`,
      ],
      "我確定，繼續抓取",
      true
    );
    if (!ok) return false;
  }

  if (mode !== "all") return true;

  let known = 0;
  try {
    known = (await ctx.store.loadPosts()).posts.length;
  } catch {
    known = 0;
  }

  const lines = [
    "「全部重抓」會把帳號裡所有貼文的成效重新問一遍。貼文成效必須一篇一篇單獨問，所以會跑很久。",
    known > 0
      ? `目前資料裡有 ${known} 篇，預估${humanDuration(known)}（實際篇數以這次抓到的為準）。`
      : "還沒有資料可以估算時間，篇數多的話可能要好幾分鐘。",
    "過程中可以隨時按「停止」，已經抓到的部分會照樣存檔，原有的數字也不會被清掉。",
    "日常使用建議用「更新最近貼文」就好。",
  ];
  if (ctx.settings.fetchReplies) {
    lines.splice(2, 0, "你開啟了「一併抓取我的回覆」，回覆通常比主貼文多很多，時間會再往上加。");
  }

  return confirm(ctx.app, "確定要全部重抓嗎？", lines, "開始全部重抓");
}

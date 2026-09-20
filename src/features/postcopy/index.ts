import { App, MarkdownView, Notice, Setting, TFile } from "obsidian";
import { countChars, toPostText } from "./convert";
import {
  BLANK_CHAR_LABEL,
  BlankChar,
  DEFAULT_SETTINGS,
  PostCopySettings,
} from "./types";
import type { Feature, FeatureContext } from "../../core/feature";

/**
 * 把一篇筆記（或選取的一段）轉成貼文文字，放進剪貼簿。
 *
 * 讀檔用 `cachedRead`：這條路只讀不寫，走快取比較快，也不會動到筆記。
 */
async function copyAsPost(
  app: App,
  settings: PostCopySettings,
  file: TFile,
  selection?: string
) {
  const picked = selection?.trim() ? selection : null;
  const raw = picked ?? (await app.vault.cachedRead(file));
  const text = toPostText(raw, settings);

  if (!text) {
    new Notice("沒有可以複製的內容（整篇只有 frontmatter 或標記）。");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    new Notice("複製失敗：這個環境不允許寫入剪貼簿。");
    return;
  }
  const n = countChars(text);
  new Notice(picked ? `已複製選取範圍（${n} 字）` : `已複製為 Facebook 貼文（${n} 字）`);
}

export const postCopyFeature: Feature<PostCopySettings> = {
  id: "postcopy",
  name: "複製為社群貼文",
  description:
    "把筆記轉成可以直接貼到 Facebook 的純文字：拿掉 frontmatter 與 Markdown 標記，" +
    "並讓空行在貼上之後不會被 Facebook 吃掉。只影響剪貼簿，不會改動筆記。",
  defaults: DEFAULT_SETTINGS,

  onload(ctx: FeatureContext<PostCopySettings>) {
    const { app, plugin } = ctx;

    plugin.addCommand({
      id: "postcopy-facebook",
      name: "複製為 Facebook 貼文",
      checkCallback: (checking) => {
        const view = app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) return false;
        if (checking) return true;
        // 有選取就只轉選取的那一段：貼文常常只取文章裡的一節
        void copyAsPost(app, ctx.settings, view.file, view.editor.getSelection());
        return true;
      },
    });

    // 檔案右鍵選單（檔案總管、分頁標題、編輯器選單、連結右鍵都會出現）。
    // 指令要記快捷鍵或開命令面板，右鍵是「想得起來」的那個入口
    plugin.registerEvent(
      app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        menu.addItem((item) =>
          item
            .setTitle("複製為 Facebook 貼文")
            .setIcon("clipboard-copy")
            .onClick(() => copyAsPost(app, ctx.settings, file))
        );
      })
    );
  },

  buildSettings(containerEl: HTMLElement, ctx: FeatureContext<PostCopySettings>) {
    new Setting(containerEl)
      .setName("拆掉 Markdown 標記")
      .setDesc(
        "Facebook 不認得 Markdown：**粗體** 貼過去會連星號一起出現，## 標題 會多出井字號。" +
          "開啟後標記會拿掉、文字留著；連結會變成「文字 (網址)」，圖片與 %% 註解 %% 會整個移除。" +
          "#標籤 會原樣保留（那在 Facebook 上本來就是 hashtag）。"
      )
      .addToggle((t) =>
        t.setValue(ctx.settings.stripMarkdown).onChange(async (v) => {
          ctx.settings.stripMarkdown = v;
          await ctx.save();
        })
      );

    new Setting(containerEl)
      .setName("空行保護字元")
      .setDesc(
        "Facebook 會把貼上的空行吃掉，所以要在空行放一個看不見、但不算空白的字元。" +
          "預設的零寬空格完全看不出來；萬一哪天失效（空行又不見了），改成盲文空白試試。"
      )
      .addDropdown((d) => {
        for (const key of Object.keys(BLANK_CHAR_LABEL) as BlankChar[]) {
          d.addOption(key, BLANK_CHAR_LABEL[key]);
        }
        d.setValue(ctx.settings.blankChar).onChange(async (v) => {
          ctx.settings.blankChar = v as BlankChar;
          await ctx.save();
        });
      });

    new Setting(containerEl)
      .setName("連續空格也保護")
      .setDesc(
        "Facebook 同樣會把連續的空格縮成一個，縮排與刻意拉開的字距都會消失。" +
          "用的是上面那個字元；選「不處理」時這一項不會生效。"
      )
      .addToggle((t) =>
        t.setValue(ctx.settings.protectSpaces).onChange(async (v) => {
          ctx.settings.protectSpaces = v;
          await ctx.save();
        })
      );
  },
};

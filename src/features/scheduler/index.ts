import {
  App,
  MarkdownView,
  Notice,
  Platform,
  Setting,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import { isPinned, normalizeDate, setArticleSchedule, setPinned } from "./articles";
import { CALENDAR_VIEW_TYPE, CalendarView } from "./calendarView";
import type { SchedulerContext } from "./context";
import { AddTodoModal, ScheduleModal } from "./modals";
import { ReminderService } from "./reminder";
import { TodoStore } from "./todoStore";
import {
  CALENDAR_LOCATION_LABEL,
  CalendarLocation,
  DEFAULT_SETTINGS,
  SchedulerSettings,
  todayStr,
} from "./types";
import type { Feature, FeatureContext } from "../../core/feature";

/** 依設定產生一個新的空分頁來放月曆 */
function newCalendarLeaf(app: App, location: CalendarLocation): WorkspaceLeaf | null {
  switch (location) {
    case "right":
      return app.workspace.getRightLeaf(false);
    case "left":
      return app.workspace.getLeftLeaf(false);
    case "window":
      // 手機版沒有獨立視窗，退回一般分頁
      return app.workspace.getLeaf(Platform.isDesktopApp ? "window" : "tab");
    default:
      return app.workspace.getLeaf("tab");
  }
}

/**
 * 開啟發佈月曆。
 *
 * 月曆已經開著時只把它顯示出來，**不搬動它的位置** ——
 * 使用者把月曆拖到右側邊欄（或任何地方）的配置會一直保留，
 * 重開 Obsidian 也由 Obsidian 自己的版面記錄還原。
 * 只有在完全找不到月曆、要新開一個時，才依「月曆開啟位置」設定決定放哪。
 */
async function activateCalendar(app: App, settings: SchedulerSettings): Promise<void> {
  const existing = app.workspace.getLeavesOfType(CALENDAR_VIEW_TYPE);
  if (existing.length > 0) {
    app.workspace.revealLeaf(existing[0]);
    return;
  }
  const leaf = newCalendarLeaf(app, settings.calendarLocation);
  if (!leaf) {
    new Notice("無法開啟發佈月曆，請改用「月曆開啟位置」設定選別的位置。");
    return;
  }
  await leaf.setViewState({ type: CALENDAR_VIEW_TYPE, active: true });
  app.workspace.revealLeaf(leaf);
}

/**
 * 讓開著的月曆立刻套用新設定（檔案瀏覽相關的設定改了要馬上看得到）。
 * 只重畫內容，不碰月曆的位置。
 */
function refreshCalendars(app: App) {
  for (const leaf of app.workspace.getLeavesOfType(CALENDAR_VIEW_TYPE)) {
    const view = leaf.view;
    if (view instanceof CalendarView) view.render();
  }
}

/** 開啟排程對話框（指令與右鍵選單共用），已有排程時帶入現值 */
function openScheduleModal(ctx: SchedulerContext, file: TFile) {
  const fm = ctx.app.metadataCache.getFileCache(file)?.frontmatter;
  new ScheduleModal(
    ctx.app,
    file.basename,
    async (date, platform) => {
      await setArticleSchedule(ctx.app, file, {
        status: "scheduled",
        publishDate: date,
        platform: platform || null,
      });
      new Notice(`已排程：${file.basename} → ${date}`);
    },
    {
      date: normalizeDate(fm?.publish_date),
      platform: typeof fm?.platform === "string" ? fm.platform : null,
    }
  ).open();
}

/** 開啟「筆記加入待辦」對話框（指令與右鍵選單共用），內容預填筆記連結 */
function openNoteTodoModal(ctx: SchedulerContext, file: TFile) {
  // 用 fileToLinktext 產生連結文字，同名筆記在不同資料夾時會自動帶路徑
  const link = ctx.app.metadataCache.fileToLinktext(file, ctx.settings.todoFilePath);
  new AddTodoModal(
    ctx.app,
    async (text, due) => {
      await ctx.todoStore.add(text, due);
      new Notice("已新增待辦");
    },
    undefined,
    `[[${link}]] `
  ).open();
}

export const schedulerFeature: Feature<SchedulerSettings> = {
  id: "scheduler",
  name: "文章發佈排程與待辦",
  description:
    "用月曆安排文章的發佈日期、管理待辦事項，到期與逾期都會主動提醒；" +
    "月曆下方還可以直接瀏覽並開啟你常用資料夾裡的筆記。",
  defaults: DEFAULT_SETTINGS,

  onload(fctx: FeatureContext<SchedulerSettings>) {
    const app = fctx.app;
    const plugin = fctx.plugin;

    const todoStore = new TodoStore(app, () => fctx.settings);
    const ctx: SchedulerContext = {
      app,
      plugin,
      settings: fctx.settings,
      save: () => fctx.save(),
      todoStore,
      activateCalendar: () => activateCalendar(app, fctx.settings),
    };
    const reminder = new ReminderService(app, ctx);

    plugin.registerView(CALENDAR_VIEW_TYPE, (leaf) => new CalendarView(leaf, ctx));

    plugin.addRibbonIcon("calendar-days", "開啟發佈月曆", () => ctx.activateCalendar());

    // 指令
    plugin.addCommand({
      id: "schedule-current-note",
      name: "將目前筆記排入發佈行程",
      checkCallback: (checking) => {
        const view = app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) return false;
        if (checking) return true;
        openScheduleModal(ctx, view.file);
        return true;
      },
    });

    plugin.addCommand({
      id: "mark-published",
      name: "標記目前筆記為已發佈",
      checkCallback: (checking) => {
        const view = app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) return false;
        if (checking) return true;
        const file = view.file;
        setArticleSchedule(app, file, { status: "published", publishedDate: todayStr() }).then(() =>
          new Notice(`已標記為已發佈：${file.basename}`)
        );
        return true;
      },
    });

    plugin.addCommand({
      id: "add-current-note-todo",
      name: "將目前筆記加入待辦",
      checkCallback: (checking) => {
        const view = app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) return false;
        if (checking) return true;
        openNoteTodoModal(ctx, view.file);
        return true;
      },
    });

    plugin.addCommand({
      id: "add-todo",
      name: "新增待辦",
      callback: () => {
        new AddTodoModal(app, async (text, due) => {
          await todoStore.add(text, due);
          new Notice("已新增待辦");
        }).open();
      },
    });

    plugin.addCommand({
      id: "open-calendar",
      name: "開啟發佈月曆",
      callback: () => ctx.activateCalendar(),
    });
    plugin.addCommand({
      id: "check-reminders",
      name: "立即檢查到期提醒",
      callback: () => reminder.check(true),
    });

    // 檔案右鍵選單（檔案總管、分頁標題、編輯器選單、連結右鍵都會出現）：
    // 排入發佈行程、加入待辦、加入／移除釘選
    plugin.registerEvent(
      app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        menu.addItem((item) =>
          item
            .setTitle("排入發佈行程")
            .setIcon("calendar-plus")
            .onClick(() => openScheduleModal(ctx, file))
        );
        menu.addItem((item) =>
          item
            .setTitle("標記為已發佈")
            .setIcon("check")
            .onClick(async () => {
              // 沒有月曆格子的日期可用，實際發佈日就是今天
              await setArticleSchedule(app, file, {
                status: "published",
                publishedDate: todayStr(),
              });
              new Notice(`已標記為已發佈：${file.basename}`);
            })
        );
        menu.addItem((item) =>
          item
            .setTitle("加入待辦")
            .setIcon("list-plus")
            .onClick(() => openNoteTodoModal(ctx, file))
        );
        const pinned = isPinned(app, file);
        menu.addItem((item) =>
          item
            .setTitle(pinned ? "移除釘選" : "加入釘選")
            .setIcon(pinned ? "pin-off" : "pin")
            .onClick(async () => {
              try {
                await setPinned(app, file, !pinned);
                new Notice(pinned ? `已移除釘選：${file.basename}` : `已釘選：${file.basename}`);
              } catch (e) {
                new Notice("寫入 frontmatter 失敗，請檢查該筆記的 YAML 是否格式正確");
              }
            })
        );
      })
    );

    // 啟動後檢查一次提醒（等 metadataCache 就緒），之後每小時檢查
    app.workspace.onLayoutReady(() => {
      window.setTimeout(() => reminder.check(), 3000);
      plugin.registerInterval(window.setInterval(() => reminder.check(), 60 * 60 * 1000));
    });
  },

  buildSettings(containerEl: HTMLElement, ctx: FeatureContext<SchedulerSettings>) {
    new Setting(containerEl)
      .setName("文章掃描資料夾")
      .setDesc("留空表示掃描整個 vault。填資料夾路徑（例如：文章）則只掃描該資料夾內的筆記。")
      .addText((t) =>
        t
          .setPlaceholder("留空 = 整個 vault")
          .setValue(ctx.settings.articleFolder)
          .onChange(async (v) => {
            ctx.settings.articleFolder = v.trim();
            await ctx.save();
          })
      );

    new Setting(containerEl)
      .setName("Todo 檔案位置")
      .setDesc("待辦事項儲存的 Markdown 檔（vault 相對路徑）。檔案不存在時會自動建立。")
      .addText((t) =>
        t
          .setPlaceholder("Todo.md")
          .setValue(ctx.settings.todoFilePath)
          .onChange(async (v) => {
            ctx.settings.todoFilePath = v.trim() || "Todo.md";
            await ctx.save();
          })
      );

    new Setting(containerEl)
      .setName("月曆開啟位置")
      .setDesc(
        "月曆還沒開啟時，要把它開在哪裡。已經開著的月曆一律留在原處，" +
          "拖到別的地方放的位置會一直保留，這個設定不會把它搬走。"
      )
      .addDropdown((d) => {
        for (const key of Object.keys(CALENDAR_LOCATION_LABEL) as CalendarLocation[]) {
          d.addOption(key, CALENDAR_LOCATION_LABEL[key]);
        }
        d.setValue(ctx.settings.calendarLocation).onChange(async (v) => {
          ctx.settings.calendarLocation = v as CalendarLocation;
          await ctx.save();
        });
      });

    new Setting(containerEl)
      .setName("到期提醒")
      .setDesc("啟動 Obsidian 時與每小時檢查，今日到期與逾期的文章、待辦會跳出通知。")
      .addToggle((t) =>
        t.setValue(ctx.settings.reminderEnabled).onChange(async (v) => {
          ctx.settings.reminderEnabled = v;
          await ctx.save();
        })
      );

    new Setting(containerEl)
      .setName("顯示檔案瀏覽")
      .setDesc(
        "在月曆最底部加一個「檔案瀏覽」收合區，可以一邊看月曆一邊翻資料夾。" +
          "預設是收起來的，點一下才展開。"
      )
      .addToggle((t) =>
        t.setValue(ctx.settings.fileBrowserEnabled).onChange(async (v) => {
          ctx.settings.fileBrowserEnabled = v;
          await ctx.save();
          refreshCalendars(ctx.app);
        })
      );

    new Setting(containerEl)
      .setName("常用資料夾")
      .setDesc(
        "一行一個資料夾路徑（例如：文章/2026），會出現在檔案瀏覽的 ★ 選單裡，點一下就跳過去。" +
          "也可以直接在檔案瀏覽裡按 ★ →「將目前資料夾加入常用」。"
      )
      .addTextArea((t) => {
        t.setPlaceholder("文章/2026\n草稿")
          .setValue(ctx.settings.favoriteFolders.join("\n"))
          .onChange(async (v) => {
            ctx.settings.favoriteFolders = v
              .split("\n")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            await ctx.save();
          });
        t.inputEl.rows = 4;
      });

    new Setting(containerEl)
      .setName("檔案瀏覽只顯示 Markdown 檔")
      .setDesc("開啟後，圖片、PDF 等非筆記檔案不會列出來（資料夾照常顯示）。")
      .addToggle((t) =>
        t.setValue(ctx.settings.fileBrowserMdOnly).onChange(async (v) => {
          ctx.settings.fileBrowserMdOnly = v;
          await ctx.save();
          refreshCalendars(ctx.app);
        })
      );
  },
};

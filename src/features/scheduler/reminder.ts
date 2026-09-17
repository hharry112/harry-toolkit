import { App, Notice } from "obsidian";
import type { SchedulerContext } from "./context";
import { scanArticles } from "./articles";
import { todayStr } from "./types";

/**
 * 提醒系統：
 * - Obsidian 啟動後檢查一次（每天第一次啟動一定會提醒）
 * - 之後每小時檢查一次；同一天內只在「有新項目到期」時再提醒，避免洗版
 */
export class ReminderService {
  /** 這個 session 已提醒過的項目 key，避免重複跳通知 */
  private notified = new Set<string>();

  constructor(private app: App, private ctx: SchedulerContext) {}

  async check(force = false): Promise<void> {
    if (!this.ctx.settings.reminderEnabled && !force) return;
    const today = todayStr();
    const lines: string[] = [];

    const articles = scanArticles(this.app, this.ctx.settings);
    for (const a of articles) {
      if (a.status !== "scheduled" || !a.publishDate || a.publishDate > today) continue;
      const key = `a:${a.file.path}:${a.publishDate}`;
      if (!force && this.notified.has(key)) continue;
      this.notified.add(key);
      const tag = a.publishDate < today ? "逾期" : "今天";
      lines.push(`📝 ${tag}發佈：${a.file.basename}（${a.publishDate}）`);
    }

    const todos = await this.ctx.todoStore.list();
    for (const t of todos) {
      if (t.done || !t.dueDate || t.dueDate > today) continue;
      const key = `t:${t.text}:${t.dueDate}`;
      if (!force && this.notified.has(key)) continue;
      this.notified.add(key);
      const tag = t.dueDate < today ? "逾期" : "今天";
      lines.push(`☑️ ${tag}待辦：${t.text}（${t.dueDate}）`);
    }

    if (lines.length > 0) {
      new Notice(`Harry Toolkit 到期提醒\n${lines.join("\n")}`, 15000);
    } else if (force) {
      new Notice("目前沒有到期或逾期的項目 🎉");
    }
  }
}

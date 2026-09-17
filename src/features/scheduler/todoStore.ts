import { App, Notice, TFile, normalizePath } from "obsidian";
import { TodoItem, SchedulerSettings, isValidDateStr } from "./types";

/**
 * Todo 資料儲存在使用者指定的 Markdown 檔，格式與 Obsidian 原生 checkbox 相容：
 *   - [ ] 事項內容 📅 2026-07-10
 *   - [x] 已完成事項
 * 停用插件後資料仍是普通 Markdown。
 */

const TODO_LINE = /^(\s*)- \[( |x|X)\] (.*)$/;
const DUE_MARK = /\s*📅\s*(\d{4}-\d{2}-\d{2})\s*/;

export function parseTodoLine(line: string, lineNo: number): TodoItem | null {
  const m = line.match(TODO_LINE);
  if (!m) return null;
  let text = m[3];
  let dueDate: string | null = null;
  const dm = text.match(DUE_MARK);
  if (dm && isValidDateStr(dm[1])) {
    dueDate = dm[1];
    text = text.replace(DUE_MARK, " ").trim();
  }
  return { line: lineNo, text: text.trim(), done: m[2].toLowerCase() === "x", dueDate };
}

export function buildTodoLine(text: string, done: boolean, dueDate: string | null): string {
  const due = dueDate ? ` 📅 ${dueDate}` : "";
  return `- [${done ? "x" : " "}] ${text}${due}`;
}

export class TodoStore {
  constructor(private app: App, private getSettings: () => SchedulerSettings) {}

  private get path(): string {
    return normalizePath(this.getSettings().todoFilePath || "Todo.md");
  }

  private async getOrCreateFile(): Promise<TFile | null> {
    const existing = this.app.vault.getFileByPath(this.path);
    if (existing) return existing;
    try {
      return await this.app.vault.create(this.path, "# 待辦事項\n\n");
    } catch (e) {
      new Notice(`無法建立 Todo 檔案：${this.path}`);
      return null;
    }
  }

  getFile(): TFile | null {
    return this.app.vault.getFileByPath(this.path);
  }

  async list(): Promise<TodoItem[]> {
    const file = this.getFile();
    if (!file) return [];
    const content = await this.app.vault.cachedRead(file);
    const items: TodoItem[] = [];
    content.split("\n").forEach((line, i) => {
      const item = parseTodoLine(line, i);
      if (item) items.push(item);
    });
    return items;
  }

  async add(text: string, dueDate: string | null): Promise<void> {
    const file = await this.getOrCreateFile();
    if (!file) return;
    await this.app.vault.process(file, (content) => {
      const line = buildTodoLine(text, false, dueDate);
      if (content.length === 0) return line + "\n";
      return content.replace(/\n*$/, "\n") + line + "\n";
    });
  }

  /** 依行號操作前，用原始文字比對確認該行沒被別的編輯動過，避免改錯行 */
  private async processLine(
    item: TodoItem,
    fn: (lines: string[], idx: number) => void
  ): Promise<boolean> {
    const file = this.getFile();
    if (!file) return false;
    let ok = false;
    await this.app.vault.process(file, (content) => {
      const lines = content.split("\n");
      let idx = -1;
      if (item.line < lines.length && parseTodoLine(lines[item.line], item.line)?.text === item.text) {
        idx = item.line;
      } else {
        idx = lines.findIndex((l, i) => {
          const p = parseTodoLine(l, i);
          return p !== null && p.text === item.text && p.done === item.done && p.dueDate === item.dueDate;
        });
      }
      if (idx < 0) return content;
      ok = true;
      fn(lines, idx);
      return lines.join("\n");
    });
    if (!ok) new Notice("找不到這筆待辦，Todo 檔可能剛被修改，請重新整理。");
    return ok;
  }

  async toggle(item: TodoItem): Promise<void> {
    await this.processLine(item, (lines, idx) => {
      lines[idx] = buildTodoLine(item.text, !item.done, item.dueDate);
    });
  }

  async remove(item: TodoItem): Promise<void> {
    await this.processLine(item, (lines, idx) => {
      lines.splice(idx, 1);
    });
  }

  async setDueDate(item: TodoItem, dueDate: string | null): Promise<void> {
    await this.processLine(item, (lines, idx) => {
      lines[idx] = buildTodoLine(item.text, item.done, dueDate);
    });
  }

  /** 只改內容文字，完成狀態與到期日保留 */
  async setText(item: TodoItem, text: string): Promise<void> {
    await this.processLine(item, (lines, idx) => {
      lines[idx] = buildTodoLine(text, item.done, item.dueDate);
    });
  }
}

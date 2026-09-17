import { App, Modal, Notice, Setting } from "obsidian";
import { isValidDateStr, todayStr } from "./types";

/**
 * 輸入一個名稱（檔案瀏覽的「重新命名」在用）。
 *
 * 只負責問名字並做基本檢查，真正的改名由呼叫端決定（要不要補副檔名、放哪個資料夾）。
 */
export class RenameModal extends Modal {
  private value: string;

  constructor(
    app: App,
    private title: string,
    initial: string,
    private onSubmit: (name: string) => void
  ) {
    super(app);
    this.value = initial;
  }

  onOpen() {
    const { contentEl } = this;
    this.setTitle(this.title);

    new Setting(contentEl).addText((t) => {
      t.setValue(this.value).onChange((v) => (this.value = v));
      t.inputEl.addClass("ht-wide-input");
      window.setTimeout(() => {
        t.inputEl.focus();
        t.inputEl.select(); // 直接選起來，要整個改寫的話打字就覆蓋掉
      }, 10);
      t.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.submit();
      });
    });

    new Setting(contentEl).addButton((b) =>
      b.setButtonText("確定").setCta().onClick(() => this.submit())
    );
  }

  private submit() {
    const name = this.value.trim();
    if (!name) {
      new Notice("名稱不能是空白");
      return;
    }
    // 先擋掉檔案系統不收的字元，比等到改名失敗才報錯清楚
    if (/[\\/:*?"<>|]/.test(name)) {
      new Notice('名稱不能包含 \\ / : * ? " < > | 這些字元');
      return;
    }
    this.close();
    this.onSubmit(name);
  }

  onClose() {
    this.contentEl.empty();
  }
}

/**
 * 是非題確認（檔案瀏覽的「刪除」在用）。
 *
 * 內建檔案總管的刪除有自己的確認，我們自己做的那條路沒有，所以要補這一道。
 */
export class ConfirmModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private message: string,
    private confirmText: string,
    private onConfirm: () => void
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    this.setTitle(this.title);
    contentEl.createEl("p", { text: this.message });

    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText(this.confirmText)
          .setWarning()
          .onClick(() => {
            this.close();
            this.onConfirm();
          })
      )
      .addButton((b) => b.setButtonText("取消").onClick(() => this.close()));
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** 排入發佈行程：選日期與平台 */
export class ScheduleModal extends Modal {
  private date = todayStr();
  private platform = "";

  constructor(
    app: App,
    private noteName: string,
    private onSubmit: (date: string, platform: string) => void,
    initial?: { date?: string | null; platform?: string | null }
  ) {
    super(app);
    if (initial?.date) this.date = initial.date;
    if (initial?.platform) this.platform = initial.platform;
  }

  onOpen() {
    const { contentEl } = this;
    this.setTitle(`排入發佈行程：${this.noteName}`);

    const submitOnEnter = (el: HTMLInputElement) =>
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.submit();
      });

    new Setting(contentEl).setName("預定發佈日").addText((t) => {
      t.inputEl.type = "date";
      t.setValue(this.date).onChange((v) => (this.date = v));
      submitOnEnter(t.inputEl);
    });

    new Setting(contentEl)
      .setName("平台")
      .setDesc("選填，純文字標記，例如：部落格、方格子")
      .addText((t) => {
        t.setValue(this.platform).onChange((v) => (this.platform = v));
        submitOnEnter(t.inputEl);
      });

    new Setting(contentEl).addButton((b) => b.setButtonText("排入行程").setCta().onClick(() => this.submit()));
  }

  private submit() {
    if (!isValidDateStr(this.date)) {
      new Notice("請選擇有效的日期");
      return;
    }
    this.close();
    this.onSubmit(this.date, this.platform.trim());
  }

  onClose() {
    this.contentEl.empty();
  }
}

/**
 * 新增 Todo。
 * initialDate 有值時（例如從月曆點日期進來）到期日預填該天；
 * initialText 有值時（例如「將目前筆記加入待辦」）內容預填該文字。
 */
export class AddTodoModal extends Modal {
  private text = "";
  private date = "";

  constructor(
    app: App,
    private onSubmit: (text: string, dueDate: string | null) => void,
    initialDate?: string,
    initialText?: string
  ) {
    super(app);
    if (initialDate && isValidDateStr(initialDate)) this.date = initialDate;
    if (initialText) this.text = initialText;
  }

  onOpen() {
    const { contentEl } = this;
    this.setTitle(this.date ? `新增待辦（${this.date}）` : "新增待辦");

    new Setting(contentEl).setName("內容").addText((t) => {
      t.setValue(this.text).onChange((v) => (this.text = v));
      t.inputEl.addClass("ht-wide-input");
      window.setTimeout(() => {
        t.inputEl.focus();
        // 預填筆記連結時，游標移到最後方便補充說明
        t.inputEl.setSelectionRange(t.inputEl.value.length, t.inputEl.value.length);
      }, 10);
      t.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.submit();
      });
    });

    new Setting(contentEl).setName("到期日（選填）").addText((t) => {
      t.inputEl.type = "date";
      t.setValue(this.date).onChange((v) => (this.date = v));
    });

    new Setting(contentEl).addButton((b) =>
      b.setButtonText("新增").setCta().onClick(() => this.submit())
    );
  }

  private submit() {
    const text = this.text.trim();
    if (!text) {
      new Notice("請輸入待辦內容");
      return;
    }
    this.close();
    this.onSubmit(text, this.date && isValidDateStr(this.date) ? this.date : null);
  }

  onClose() {
    this.contentEl.empty();
  }
}

import { App, TFile } from "obsidian";
import { Article, PublishStatus, STATUS_ORDER, SchedulerSettings } from "./types";

/** frontmatter 欄位名稱 */
export const FM_STATUS = "publish_status";
export const FM_DATE = "publish_date";
export const FM_PUBLISHED = "published_date";
export const FM_PLATFORM = "platform";
export const FM_PINNED = "pinned";

function normalizeStatus(v: unknown): PublishStatus | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase() as PublishStatus;
  return STATUS_ORDER.includes(s) ? s : null;
}

/** frontmatter 的日期值可能是字串或被 Obsidian 解析成其他型別，一律轉成 YYYY-MM-DD 字串 */
export function normalizeDate(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/** 掃描 vault（或指定資料夾）中所有帶有 publish_status 的筆記 */
export function scanArticles(app: App, settings: SchedulerSettings): Article[] {
  const folder = settings.articleFolder.replace(/^\/+|\/+$/g, "");
  const files = app.vault.getMarkdownFiles();
  const articles: Article[] = [];
  for (const file of files) {
    if (folder && !(file.path === folder || file.path.startsWith(folder + "/"))) continue;
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) continue;
    const status = normalizeStatus(fm[FM_STATUS]);
    if (!status) continue;
    articles.push({
      file,
      status,
      publishDate: normalizeDate(fm[FM_DATE]),
      publishedDate: normalizeDate(fm[FM_PUBLISHED]),
      platform: typeof fm[FM_PLATFORM] === "string" ? fm[FM_PLATFORM] : null,
    });
  }
  return articles;
}

/** 這篇筆記是否已釘選（frontmatter 解析失敗或值非 true 一律視為未釘選） */
export function isPinned(app: App, file: TFile): boolean {
  const v = app.metadataCache.getFileCache(file)?.frontmatter?.[FM_PINNED];
  return v === true || v === "true";
}

/** 掃描整個 vault 的釘選筆記（不受文章掃描資料夾限制），依檔名排序 */
export function scanPinnedNotes(app: App): TFile[] {
  return app.vault
    .getMarkdownFiles()
    .filter((file) => isPinned(app, file))
    .sort((a, b) => a.basename.localeCompare(b.basename));
}

/** 設定或移除釘選。移除時直接刪掉欄位，讓筆記回到原狀 */
export async function setPinned(app: App, file: TFile, pinned: boolean): Promise<void> {
  await app.fileManager.processFrontMatter(file, (fm) => {
    if (pinned) fm[FM_PINNED] = true;
    else delete fm[FM_PINNED];
  });
}

/** 更新一篇筆記的排程 frontmatter */
export async function setArticleSchedule(
  app: App,
  file: TFile,
  fields: { status?: PublishStatus; publishDate?: string | null; publishedDate?: string | null; platform?: string | null }
): Promise<void> {
  await app.fileManager.processFrontMatter(file, (fm) => {
    if (fields.status !== undefined) fm[FM_STATUS] = fields.status;
    if (fields.publishDate !== undefined) {
      if (fields.publishDate === null) delete fm[FM_DATE];
      else fm[FM_DATE] = fields.publishDate;
    }
    if (fields.publishedDate !== undefined) {
      if (fields.publishedDate === null) delete fm[FM_PUBLISHED];
      else fm[FM_PUBLISHED] = fields.publishedDate;
    }
    if (fields.platform !== undefined) {
      if (!fields.platform) delete fm[FM_PLATFORM];
      else fm[FM_PLATFORM] = fields.platform;
    }
  });
}

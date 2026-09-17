import type { Feature } from "../core/feature";
import { schedulerFeature } from "./scheduler";
import { scrollFeature } from "./scroll";
import { threadsFeature } from "./threads";

/**
 * 功能註冊清單。
 *
 * 新增功能只要：建 `src/features/<新功能>/index.ts` 匯出一個 `Feature`，
 * 然後在這個陣列加一行。設定頁、預設值、啟用開關都會自動生出來。
 * 陣列順序 = 設定頁上的區塊順序。
 */
export const FEATURES: Feature[] = [scrollFeature, schedulerFeature, threadsFeature];

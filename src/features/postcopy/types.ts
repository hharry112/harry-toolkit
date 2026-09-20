/**
 * 空行與連續空格要塞哪一個「看不見但不算空白」的字元。
 *
 * Facebook（Instagram 也一樣）在貼上時會把連續換行併成一個段落分隔、把連續空格縮成一個，
 * 而且會把每一行前後的空白清掉 —— 所以「在空行放一個空格」沒有用，那行 trim 完還是空的。
 * 解法是放一個「不屬於空白類」的隱形字元，那一行就不是空行了。
 */
export type BlankChar = "zwsp" | "braille" | "none";

/** 實際要塞的字元；`none` 是空字串（等於不處理） */
export const BLANK_CHAR: Record<BlankChar, string> = {
  // U+200B 零寬空格。寬度 0，貼出去完全看不出來，是這類線上轉換器長年在用的做法
  zwsp: "​",
  // U+2800 盲文空白。有一個空格的寬度，但它在 Unicode 分類上不是空白字元，
  // 比較不會被平台的字元清理掃掉 —— 零寬空格哪天失效了就換這個
  braille: "⠀",
  none: "",
};

export const BLANK_CHAR_LABEL: Record<BlankChar, string> = {
  zwsp: "零寬空格（推薦，完全看不見）",
  braille: "盲文空白（零寬空格失效時改用這個）",
  none: "不處理（空行會被 Facebook 吃掉）",
};

export interface PostCopySettings {
  /** 拆掉 Markdown 標記（Facebook 不認得，星號、井字號會原樣顯示出來） */
  stripMarkdown: boolean;
  /** 空行用哪個字元保護 */
  blankChar: BlankChar;
  /** 連續空格也一起保護（縮排、刻意拉開的字距） */
  protectSpaces: boolean;
}

export const DEFAULT_SETTINGS: PostCopySettings = {
  stripMarkdown: true,
  blankChar: "zwsp",
  protectSpaces: true,
};

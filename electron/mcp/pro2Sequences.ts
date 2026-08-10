/**
 * Pro2 Auto Operation Sequences
 *
 * This file is intentionally separate from sequences.ts (Pro).
 * Pro2 starts with the same test items as Pro, but its coordinates and flows
 * should be maintained here only while re-recording the new device.
 */
import { PRO2_OCR_SCENES, type SequenceOcrSceneConfig } from './ocrScenes';

/** Represents a single step in the auto operation sequence */
export interface OcrCaptureOptions {
  /** Expected mnemonic word count for this capture (12/18/20/24). */
  expectedWordCount?: number;
  /** Merge this capture with already stored mnemonic words by index. */
  mergeWithStored?: boolean;
  /** Allow partial OCR result (used by first page of 24-word capture). */
  allowPartial?: boolean;
  /** Whether checksum validation is required for this capture to be treated as success. */
  requireBip39?: boolean;
  /** Optional OCR crop override for device-specific camera framing. */
  sceneConfig?: SequenceOcrSceneConfig;
}

export interface AutoStep {
  label: string;
  x: number;
  y: number;
  depth: number;
  /** Optional delay in ms before this step executes. */
  delayBefore?: number;
  /** Optional delay in ms after this step (default: 200ms) */
  delayAfter?: number;
  /** If set, performs a swipe from (x,y) to swipeTo coordinates instead of a click */
  swipeTo?: { x: number; y: number };
  /** Optional segmented swipe count (>=1). Higher value means slower movement on screen. */
  swipeSegments?: number;
  /** Delay in ms between segmented swipe points (default: 0ms). */
  swipeSegmentDelay?: number;
  /** Delay in ms before raising stylus after swipe (default: 50ms) */
  swipeHoldDelay?: number;
  /** If set, moves arm to position without clicking. */
  moveOnly?: boolean;
  /** If set, moves arm to position without clicking, then triggers OCR capture. */
  ocrCapture?: boolean | OcrCaptureOptions;
  /** If set, performs verification OCR and clicks the correct option */
  ocrVerify?: {
    options: { x: number; y: number; depth: number }[];
    /** Loop mode: answer questions until none detected; auto-recover from 助记词不正确 error page. */
    loop?: boolean;
  };
}

/**
 * PageAction: an atomic, reusable page-level operation.
 * Each action represents one logical interaction on a device page
 * (e.g., "select language", "enter PIN", "click create wallet").
 * Actions can be freely composed into sequences.
 */
export interface PageAction {
  id: string;
  name: string;
  /** Logical group for organization (e.g., '初始设置', '钱包路径') */
  group: string;
  /** Steps that make up this action */
  steps: AutoStep[];
  /** Optional dynamic step builder evaluated when the sequence runs. */
  buildSteps?: () => AutoStep[];
  /** Optional mnemonic source to be resolved in Node/Electron main before execution. */
  mnemonicSource?: MnemonicSource;
}

export interface MnemonicSource {
  section: 'bip39' | 'slip39';
  keys: string[];
  mode: 'single' | 'shares-all' | 'shares-random';
  pickCount?: number;
}

// ============================================================================
// Keyboard coordinate mapping
// ============================================================================

/** Keyboard letter coordinates */
export const LETTER_COORDS: Record<string, { x: number; y: number }> = {
  q: { x: 192, y: 75 }, w: { x: 197, y: 75 }, e: { x: 202, y: 75 }, r: { x: 206, y: 75 },
  t: { x: 210, y: 75 }, y: { x: 215, y: 75 }, u: { x: 220, y: 75 }, i: { x: 224, y: 75 },
  o: { x: 228, y: 75 }, p: { x: 232, y: 75 },
  a: { x: 194, y: 82 }, s: { x: 199, y: 82 }, d: { x: 203, y: 82 }, f: { x: 207, y: 83 },
  g: { x: 212, y: 82 }, h: { x: 217, y: 82 }, j: { x: 222, y: 82 }, k: { x: 227, y: 82 },
  l: { x: 231, y: 82 },
  z: { x: 198, y: 91 }, x: { x: 203, y: 91 }, c: { x: 208, y: 91 }, v: { x: 213, y: 91 },
  b: { x: 218, y: 91 }, n: { x: 221, y: 91 }, m: { x: 226, y: 91 },
};

/** Number coordinates on PIN pad */
export const NUMBER_COORDS: Record<string, { x: number; y: number }> = {
  '1': { x: 198, y: 59 },
  '2': { x: 35, y: 50 },
  '3': { x: 45, y: 50 },
  '4': { x: 25, y: 60 },
  '5': { x: 35, y: 60 },
  '6': { x: 45, y: 60 },
  '7': { x: 25, y: 70 },
  '8': { x: 35, y: 70 },
  '9': { x: 45, y: 70 },
  '0': { x: 35, y: 80 },
};

/** Confirm button coordinate */
export const CONFIRM_COORD = { x: 196, y: 68 };

/** Cancel/Back button coordinate */
export const CANCEL_COORD = { x: 19, y: 87 };

/** Device button coordinates */
export const DEVICE_BUTTONS = {
  confirm: { x: 227, y: 94 },
  cancel: { x: 25, y: 85 },
  back: { x: 19, y: 87 },
  continue: { x: 212, y: 94 },
  next: { x: 212, y: 94 },
  finish: { x: 212, y: 94 },
};

/** Arm home coordinate for Pro2. */
export const DEVICE_HOME_COORD = { x: 0, y: 0 } as const;

// ============================================================================
// Helper functions
// ============================================================================

/** Delay (ms) after each letter tap when typing mnemonic words. */
export const STEP_DELAY_AFTER_LETTER_MS = 700;
/** Delay (ms) after each word confirm tap to leave a small gap before the next word. */
export const STEP_DELAY_AFTER_CONFIRM_MS = 1200;
/** Delay (ms) after the LAST word confirm — device needs time to validate the full mnemonic. */
export const STEP_DELAY_AFTER_LAST_CONFIRM_MS = 5000;

/**
 * Generates AutoStep array from a list of words.
 * Each word becomes: letter steps + confirm step.
 */
export function generateWordSteps(words: string[]): AutoStep[] {
  const steps: AutoStep[] = [];
  words.forEach((word, wordIndex) => {
    const isLastWord = wordIndex === words.length - 1;
    const lowerWord = word.toLowerCase();
    for (let i = 0; i < lowerWord.length; i++) {
      const letter = lowerWord[i];
      const coord = LETTER_COORDS[letter];
      if (coord) {
        steps.push({
          label: `W${wordIndex + 1}:${letter}`,
          x: coord.x,
          y: coord.y,
          depth: 12,
          delayAfter: STEP_DELAY_AFTER_LETTER_MS,
        });
      }
    }
    steps.push({
      label: `W${wordIndex + 1}:confirm`,
      x: CONFIRM_COORD.x,
      y: CONFIRM_COORD.y,
      depth: 12,
      delayAfter: isLastWord ? STEP_DELAY_AFTER_LAST_CONFIRM_MS : STEP_DELAY_AFTER_CONFIRM_MS,
    });
  });
  return steps;
}

export function pickRandomShares(shares: string[][], count: number): string[][] {
  const pool = [...shares];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.max(0, Math.min(count, pool.length)));
}

export function generateSlip39ShareSteps(shares: string[][]): AutoStep[] {
  const steps: AutoStep[] = [];
  let globalWordIndex = 0;

  const isLastShare = (shareIndex: number) => shareIndex === shares.length - 1;
  const isLastWordInShare = (wordInShareIndex: number, shareWords: string[]) =>
    wordInShareIndex === shareWords.length - 1;

  shares.forEach((shareWords, shareIndex) => {
    shareWords.forEach((word, wordInShareIndex) => {
      globalWordIndex += 1;
      const isLastWord = isLastShare(shareIndex) && isLastWordInShare(wordInShareIndex, shareWords);
      const lowerWord = word.toLowerCase();
      for (let i = 0; i < lowerWord.length; i++) {
        const letter = lowerWord[i];
        const coord = LETTER_COORDS[letter];
        if (coord) {
          steps.push({
            label: `W${globalWordIndex}:${letter}`,
            x: coord.x,
            y: coord.y,
            depth: 12,
            delayBefore: shareIndex > 0 && wordInShareIndex === 0 && i === 0 ? 3000 : undefined,
            delayAfter: STEP_DELAY_AFTER_LETTER_MS,
          });
        }
      }
      steps.push({
        label: `W${globalWordIndex}:confirm`,
        x: CONFIRM_COORD.x,
        y: CONFIRM_COORD.y,
        depth: 12,
        delayAfter: isLastWord ? STEP_DELAY_AFTER_LAST_CONFIRM_MS : STEP_DELAY_AFTER_CONFIRM_MS,
      });
    });

    if (shareIndex < shares.length - 1) {
      steps.push({
        label: `Share${shareIndex + 1}:confirm`,
        x: DEVICE_BUTTONS.confirm.x,
        y: DEVICE_BUTTONS.confirm.y,
        depth: 12,
        delayBefore: 5000,
        delayAfter: 5000,
      });
    }
  });

  return steps;
}

/** 12 words "all" input steps (legacy test) */
const WORDS_12_STEPS: AutoStep[] = [
  // Word 1: "all"
  { label: '点击单词a', x: 194, y: 82, depth: 12, delayAfter: 1000 },
  { label: '点击单词l', x: 231, y: 82, depth: 12, delayAfter: 1000 },
  { label: '点击单词l', x: 231, y: 82, depth: 12, delayAfter: 1000 },
  { label: '点击确认', x: 196, y: 68, depth: 12, delayAfter: 2000 },
  // Word 2: "all"
  { label: '点击单词a', x: 194, y: 82, depth: 12, delayAfter: 1000 },
  { label: '点击单词l', x: 231, y: 82, depth: 12, delayAfter: 1000 },
  { label: '点击单词l', x: 231, y: 82, depth: 12, delayAfter: 1000 },
  { label: '点击确认', x: 196, y: 68, depth: 12, delayAfter: 2000 },
  // Word 3: "all"
  { label: '点击单词a', x: 194, y: 82, depth: 12, delayAfter: 1000 },
  { label: '点击单词l', x: 231, y: 82, depth: 12, delayAfter: 1000 },
  { label: '点击单词l', x: 231, y: 82, depth: 12, delayAfter: 1000 },
  { label: '点击确认', x: 196, y: 68, depth: 12, delayAfter: 2000 },
  // Word 4: "all"
  { label: '点击单词a', x: 194, y: 82, depth: 12, delayAfter: 1000 },
  { label: '点击单词l', x: 231, y: 82, depth: 12, delayAfter: 1000 },
  { label: '点击单词l', x: 231, y: 82, depth: 12, delayAfter: 1000 },
  { label: '点击确认', x: 196, y: 68, depth: 12, delayAfter: 2000 },
  // Word 5: "all"
  { label: '点击单词a', x: 194, y: 82, depth: 12, delayAfter: 1000 },
  { label: '点击单词l', x: 231, y: 82, depth: 12, delayAfter: 1000 },
  { label: '点击单词l', x: 231, y: 82, depth: 12, delayAfter: 1000 },
  { label: '点击确认', x: 196, y: 68, depth: 12, delayAfter: 2000 },
  // Word 6: "all"
  { label: '点击单词a', x: 194, y: 82, depth: 12, delayAfter: 1000 },
  { label: '点击单词l', x: 231, y: 82, depth: 12, delayAfter: 1000 },
  { label: '点击单词l', x: 231, y: 82, depth: 12, delayAfter: 1000 },
  { label: '点击确认', x: 196, y: 68, depth: 12, delayAfter: 2000 },
  // Word 7: "all"
  { label: '点击单词a', x: 194, y: 82, depth: 12, delayAfter: 1000 },
  { label: '点击单词l', x: 231, y: 82, depth: 12, delayAfter: 1000 },
  { label: '点击单词l', x: 231, y: 82, depth: 12, delayAfter: 1000 },
  { label: '点击确认', x: 196, y: 68, depth: 12, delayAfter: 2000 },
  // Word 8: "all"
  { label: '点击单词a', x: 194, y: 82, depth: 12, delayAfter: 1000 },
  { label: '点击单词l', x: 231, y: 82, depth: 12, delayAfter: 1000 },
  { label: '点击单词l', x: 231, y: 82, depth: 12, delayAfter: 1000 },
  { label: '点击确认', x: 196, y: 68, depth: 12, delayAfter: 2000 },
  // Word 9: "all"
  { label: '点击单词a', x: 194, y: 82, depth: 12, delayAfter: 1000 },
  { label: '点击单词l', x: 231, y: 82, depth: 12, delayAfter: 1000 },
  { label: '点击单词l', x: 231, y: 82, depth: 12, delayAfter: 1000 },
  { label: '点击确认', x: 196, y: 68, depth: 12, delayAfter: 2000 },
  // Word 10: "all"
  { label: '点击单词a', x: 194, y: 82, depth: 12, delayAfter: 1000 },
  { label: '点击单词l', x: 231, y: 82, depth: 12, delayAfter: 1000 },
  { label: '点击单词l', x: 231, y: 82, depth: 12, delayAfter: 1000 },
  { label: '点击确认', x: 196, y: 68, depth: 12, delayAfter: 2000 },
  // Word 11: "all"
  { label: '点击单词a', x: 194, y: 82, depth: 12, delayAfter: 1000 },
  { label: '点击单词l', x: 231, y: 82, depth: 12, delayAfter: 1000 },
  { label: '点击单词l', x: 231, y: 82, depth: 12, delayAfter: 1000 },
  { label: '点击确认', x: 196, y: 68, depth: 12, delayAfter: 2000 },
  // Word 12: "all"
  { label: '点击单词a', x: 194, y: 82, depth: 12, delayAfter: 1000 },
  { label: '点击单词l', x: 231, y: 82, depth: 12, delayAfter: 1000 },
  { label: '点击单词l', x: 231, y: 82, depth: 12, delayAfter: 1000 },
  { label: '点击确认', x: 196, y: 68, depth: 12, delayAfter: 2000 },
];

// ============================================================================
// Page Action Definitions
// ============================================================================

/** All page actions organized by logical groups */
const ALL_PAGE_ACTIONS: PageAction[] = [
  // --------------------------------------------------------------------------
  // 初始设置 (Initial Setup)
  // --------------------------------------------------------------------------
  {
    id: 'create-start-position',
    name: '创建钱包起始坐标',
    group: '初始设置',
    steps: [
      { label: '移动到创建起始坐标', x: 180, y: 0, depth: 12, moveOnly: true, delayAfter: 500 },
    ],
  },
  {
    id: 'lang-zh',
    name: '选择中文',
    group: '初始设置',
    steps: [
      { label: '点击Hello', x: 215, y: 65, depth: 12, delayAfter: 300 },
      { label: '引导选择语言1', x: 212, y: 66, depth: 12, delayAfter: 300 },
      { label: '引导选择语言2', x: 207, y: 73, depth: 12, delayAfter: 8000 },
      { label: '引导选择语言3', x: 213, y: 80, depth: 12, delayAfter: 300 },
      { label: '引导继续1', x: 202, y: 94, depth: 12, delayAfter: 300 },
      { label: '引导继续2', x: 202, y: 94, depth: 12, delayAfter: 300 },
    ],
  },
  {
    id: 'pin-1111',
    name: '输入PIN码1111',
    group: '初始设置',
    steps: [
      { label: '输入PIN码1', x: 198, y: 59, depth: 12 },
      { label: '输入PIN码2', x: 198, y: 59, depth: 12 },
      { label: '输入PIN码3', x: 198, y: 59, depth: 12 },
      { label: '输入PIN码4', x: 198, y: 59, depth: 12 },
      { label: '点击确认', x: DEVICE_BUTTONS.confirm.x, y: DEVICE_BUTTONS.confirm.y, depth: 12 },
      { label: '再次确认PIN码1', x: 198, y: 59, depth: 12 },
      { label: '再次确认PIN码2', x: 198, y: 59, depth: 12 },
      { label: '再次确认PIN码3', x: 198, y: 59, depth: 12 },
      { label: '再次确认PIN码4', x: 198, y: 59, depth: 12 },
      { label: '点击确认', x: DEVICE_BUTTONS.confirm.x, y: DEVICE_BUTTONS.confirm.y, depth: 12, delayAfter: 900 },
    ],
  },
  {
    id: 'nav-continue-setup',
    name: '继续+跳过指纹',
    group: '初始设置',
    steps: [
      { label: '提示页面继续', x: 212, y: 94, depth: 12, delayAfter: 500 },
      { label: '跳过指纹', x: 212, y: 94, depth: 12, delayAfter: 500 },
      { label: '跳过指纹确认', x: 212, y: 94, depth: 12, delayAfter: 500 },
    ],
  },

  // --------------------------------------------------------------------------
  // 钱包路径 (Wallet Path)
  // --------------------------------------------------------------------------
  {
    id: 'nav-import',
    name: '导入钱包',
    group: '钱包路径',
    steps: [
      { label: '点击导入钱包', x: 212, y: 94, depth: 12 },
    ],
  },
  {
    id: 'nav-create',
    name: '创建新钱包',
    group: '钱包路径',
    steps: [
      { label: '选择创建钱包', x: 212, y: 82, depth: 12, delayAfter: 500 },
      { label: '创建流程继续1', x: 212, y: 94, depth: 12, delayAfter: 500 },
      { label: '创建流程继续2', x: 212, y: 94, depth: 12, delayAfter: 500 },
      { label: '创建流程继续3', x: 212, y: 94, depth: 12, delayAfter: 1000 },
    ],
  },

  // --------------------------------------------------------------------------
  // 导入钱包 (Import Wallet)
  // --------------------------------------------------------------------------
  {
    id: 'select-mnemonic',
    name: '选择助记词',
    group: '导入钱包',
    steps: [
      { label: '点击助记词', x: 212, y: 82, depth: 12 },
    ],
  },

  // --------------------------------------------------------------------------
  // 词数选择 (Word Count Selection)
  // --------------------------------------------------------------------------
  {
    id: 'select-12-words',
    name: '选择12个单词',
    group: '词数选择',
    steps: [
      { label: '选择12个单词', x: 196, y: 61, depth: 12 },
      { label: '点击继续', x: 212, y: 94, depth: 12 },
    ],
  },
  {
    id: 'select-18-words',
    name: '选择18个单词',
    group: '词数选择',
    steps: [
      { label: '选择18个单词', x: 196, y: 71, depth: 12 },
      { label: '点击继续', x: 212, y: 94, depth: 12 },
    ],
  },
  {
    id: 'select-20-words',
    name: '选择20个单词',
    group: '词数选择',
    steps: [
      // 20/33 词选项在列表底部，需先上滑到底才能看到
      {
        label: '词数列表上滑',
        x: 213, y: 85, depth: 12,
        swipeTo: { x: 213, y: 65 },
        swipeSegments: 1,
        swipeHoldDelay: 300,
        delayAfter: 1000,
      },
      { label: '选择20个单词', x: 197, y: 84, depth: 12, delayAfter: 600 },
      { label: '点击继续', x: 212, y: 94, depth: 12 },
    ],
  },
  {
    id: 'select-24-words',
    name: '选择24个单词',
    group: '词数选择',
    steps: [
      { label: '选择24个单词', x: 196, y: 81, depth: 12 },
      { label: '点击继续', x: 212, y: 94, depth: 12 },
    ],
  },
  {
    id: 'select-33-words',
    name: '选择33个单词',
    group: '词数选择',
    steps: [
      // 20/33 词选项在列表底部，需先上滑到底才能看到
      {
        label: '词数列表上滑',
        x: 213, y: 85, depth: 12,
        swipeTo: { x: 213, y: 65 },
        swipeSegments: 1,
        swipeHoldDelay: 300,
        delayAfter: 1000,
      },
      { label: '选择33个单词', x: 197, y: 94, depth: 12, delayAfter: 600 },
      { label: '点击继续', x: 212, y: 94, depth: 12 },
    ],
  },

  // --------------------------------------------------------------------------
  // 创建钱包 (Create Wallet Flow)
  // --------------------------------------------------------------------------
  {
    id: 'create-backup-confirm',
    name: '备份确认',
    group: '创建钱包',
    steps: [
      { label: '开始备份勾选1', x: 20, y: 40, depth: 12 },
      { label: '开始备份勾选2', x: 20, y: 50, depth: 12 },
      { label: '开始备份勾选3', x: 20, y: 65, depth: 12 },
      { label: '点击备份', x: 40, y: 85, depth: 12 },
    ],
  },
  {
    id: 'create-generate-intros',
    name: '生成助记词介绍页(继续x2+备份)',
    group: '创建钱包',
    steps: [
      // 选完位数后依次出现: 设备生成助记词介绍 -> 助记词保密提示 -> 准备记录
      { label: '介绍页继续1', x: 212, y: 94, depth: 12, delayAfter: 1200 },
      { label: '介绍页继续2', x: 212, y: 94, depth: 12, delayAfter: 1200 },
      { label: '点击备份', x: 212, y: 94, depth: 12, delayAfter: 1500 },
    ],
  },
  {
    id: 'create-more-options',
    name: '创建/导入选择页点击更多',
    group: '创建钱包',
    steps: [
      { label: '点击更多', x: 229, y: 31, depth: 12, delayAfter: 1000 },
    ],
  },
  {
    id: 'create-select-18-words',
    name: '创建钱包选择18词',
    group: '创建钱包',
    steps: [
      { label: '选择18位助记词', x: 196, y: 69, depth: 12, delayAfter: 1000 },
    ],
  },
  {
    id: 'create-select-24-words',
    name: '创建钱包选择24词',
    group: '创建钱包',
    steps: [
      { label: '选择24位助记词', x: 196, y: 79, depth: 12, delayAfter: 1000 },
    ],
  },
  {
    id: 'create-expand-word-options',
    name: '创建钱包展开助记词选项',
    group: '创建钱包',
    steps: [
      { label: '点击更多', x: 229, y: 31, depth: 12, delayAfter: 1000 },
    ],
  },
  {
    id: 'create-more-options-scroll',
    name: '更多选项页上滑',
    group: '创建钱包',
    steps: [
      {
        label: '更多选项页上滑',
        x: 196,
        y: 87,
        depth: 12,
        swipeTo: { x: 196, y: 47 },
        swipeSegments: 5,
        swipeSegmentDelay: 45,
        swipeHoldDelay: 220,
        delayAfter: 1400,
      },
    ],
  },
  {
    id: 'create-mnemonic-scroll-10',
    name: '助记词页上滑10',
    group: '创建钱包',
    steps: [
      {
        // 实测参数(滑动调试面板校准): 上滑15格后18词9行可稳定全显
        label: '助记词页上滑15',
        x: 213,
        y: 85,
        depth: 12,
        swipeTo: { x: 213, y: 70 },
        swipeSegments: 1,
        swipeHoldDelay: 300,
        delayAfter: 1800,
      },
    ],
  },
  {
    id: 'create-mnemonic-scroll-15',
    name: '助记词页上滑15',
    group: '创建钱包',
    steps: [
      {
        label: '助记词页上滑15',
        x: 50,
        y: 78,
        depth: 12,
        swipeTo: { x: 50, y: 63 },
        swipeSegments: 5,
        swipeSegmentDelay: 45,
        swipeHoldDelay: 220,
        delayAfter: 1400,
      },
    ],
  },
  {
    id: 'create-slip39-mnemonic-scroll-15-slow',
    name: 'SLIP39助记词页上滑15(慢速)',
    group: '创建钱包',
    steps: [
      {
        // 20词(10行)同样一屏放不下：一段式大幅滑到底（列表末尾夹停），
        // 与第一段(未滑动)合并后覆盖全部20词
        label: 'SLIP39助记词页上滑15(慢速)',
        x: 213,
        y: 85,
        depth: 12,
        swipeTo: { x: 213, y: 45 },
        swipeSegments: 1,
        swipeHoldDelay: 300,
        delayAfter: 2200,
      },
    ],
  },
  {
    id: 'create-mnemonic-scroll-20',
    name: '助记词页上滑20',
    group: '创建钱包',
    steps: [
      {
        // 24词共12行：一段式大幅滑到底（列表末尾夹停，落点确定），
        // 底部视图显示第4-12行，与第一段(1-7行)合并后覆盖全部24词
        label: '助记词页上滑20',
        x: 213,
        y: 85,
        depth: 12,
        swipeTo: { x: 213, y: 45 },
        swipeSegments: 1,
        swipeHoldDelay: 300,
        delayAfter: 2200,
      },
    ],
  },
  {
    id: 'create-mnemonic-scroll-40',
    name: '助记词页上滑40',
    group: '创建钱包',
    steps: [
      {
        label: '助记词页上滑40',
        x: 50,
        y: 78,
        depth: 12,
        swipeTo: { x: 50, y: 38 },
        swipeHoldDelay: 240,
        delayAfter: 1500,
      },
    ],
  },
  {
    id: 'create-slip39-scroll-large',
    name: 'SLIP39配置页大幅上滑',
    group: '创建钱包',
    steps: [
      {
        label: 'SLIP39配置页大幅上滑',
        x: 50,
        y: 82,
        depth: 12,
        swipeTo: { x: 50, y: 38 },
        swipeHoldDelay: 240,
        delayAfter: 1400,
      },
    ],
  },
  {
    id: 'create-slip39-select-single',
    name: '创建SLIP39选择单份',
    group: '创建钱包',
    steps: [
      { label: '选择slip39单分片备份', x: 196, y: 49, depth: 12, delayAfter: 900 },
    ],
  },
  {
    id: 'create-slip39-select-multi',
    name: '创建SLIP39选择多份',
    group: '创建钱包',
    steps: [
      { label: '选择slip39多分片备份', x: 196, y: 59, depth: 12, delayAfter: 900 },
    ],
  },
  {
    id: 'create-slip39-shares-2',
    name: 'SLIP39份额选择2',
    group: '创建钱包',
    steps: [
      { label: '选择2份额', x: 195, y: 48, depth: 12, delayAfter: 700 },
    ],
  },
  {
    id: 'create-slip39-shares-8',
    name: 'SLIP39份额选择8',
    group: '创建钱包',
    steps: [
      { label: '选择8份额', x: 204, y: 57, depth: 12, delayAfter: 700 },
    ],
  },
  {
    id: 'create-slip39-shares-16',
    name: 'SLIP39份额选择16',
    group: '创建钱包',
    steps: [
      { label: '选择16份额', x: 228, y: 64, depth: 12, delayAfter: 700 },
    ],
  },
  {
    id: 'create-slip39-threshold-2',
    name: 'SLIP39阈值选择2',
    group: '创建钱包',
    steps: [
      { label: '选择2阈值', x: 196, y: 83, depth: 12, delayAfter: 700 },
    ],
  },
  {
    id: 'create-slip39-threshold-8',
    name: 'SLIP39阈值选择8',
    group: '创建钱包',
    steps: [
      // 选8份额后阈值选项超出屏幕，需要先上滑露出"8"再点击
      {
        label: '阈值区上滑',
        x: 204,
        y: 73,
        depth: 12,
        swipeTo: { x: 204, y: 53 },
        swipeSegments: 5,
        swipeSegmentDelay: 45,
        swipeHoldDelay: 220,
        delayAfter: 1200,
      },
      { label: '选择8阈值', x: 204, y: 80, depth: 12, delayAfter: 700 },
    ],
  },
  {
    id: 'create-slip39-config-continue',
    name: 'SLIP39配置确认继续',
    group: '创建钱包',
    steps: [
      { label: '确认配置并继续', x: 212, y: 94, depth: 12, delayAfter: 900 },
    ],
  },
  {
    id: 'create-screenshot-12',
    name: '截图识别(12词)',
    group: '创建钱包',
    steps: [
      {
        label: '助记词页轻微上滑',
        x: 212,
        y: 80,
        depth: 12,
        swipeTo: { x: 212, y: 50 },
        swipeSegments: 1,
        swipeHoldDelay: 120,
        delayAfter: 1000,
      },
      {
        label: '移动到截图位置',
        x: 259,
        y: 0,
        depth: 12,
        ocrCapture: {
          expectedWordCount: 12,
          requireBip39: true,
          sceneConfig: PRO2_OCR_SCENES.createWallet.mnemonic12,
        },
        delayAfter: 2000,
      },
    ],
  },
  {
    id: 'create-screenshot-18-part1',
    name: '截图识别(18词-第一页)',
    group: '创建钱包',
    steps: [
      {
        // pro2 视口只容纳约8行，18词(9行)无法一屏全显：先在未滑动状态
        // 抓取第1-7/10-16行（关键是第1、10词），滑动到底后再抓其余
        label: '移动到截图位置(18词-1)',
        x: 259,
        y: 0,
        depth: 12,
        ocrCapture: {
          expectedWordCount: 18,
          mergeWithStored: true,
          allowPartial: true,
          requireBip39: false,
          sceneConfig: PRO2_OCR_SCENES.createWallet.mnemonic24Part1,
        },
        delayAfter: 2000,
      },
    ],
  },
  {
    id: 'create-screenshot-18-part2',
    name: '截图识别(18词-第二页)',
    group: '创建钱包',
    steps: [
      {
        label: '移动到截图位置(18词-2)',
        x: 259,
        y: 0,
        depth: 12,
        ocrCapture: {
          expectedWordCount: 18,
          mergeWithStored: true,
          allowPartial: false,
          requireBip39: true,
          sceneConfig: PRO2_OCR_SCENES.createWallet.mnemonic24Part2,
        },
        delayAfter: 2000,
      },
    ],
  },
  {
    id: 'create-screenshot-20',
    name: '截图识别(20词)',
    group: '创建钱包',
    steps: [
      {
        label: '移动到截图位置',
        x: 85,
        y: 0,
        depth: 12,
        ocrCapture: { expectedWordCount: 20, requireBip39: false },
        delayAfter: 2000,
      },
    ],
  },
  {
    id: 'create-screenshot-20-part1',
    name: '截图识别(20词-第一页)',
    group: '创建钱包',
    steps: [
      {
        label: '移动到截图位置(20词-1)',
        x: 259,
        y: 0,
        depth: 12,
        ocrCapture: {
          expectedWordCount: 20,
          mergeWithStored: true,
          allowPartial: true,
          requireBip39: false,
          sceneConfig: PRO2_OCR_SCENES.createWallet.mnemonic24Part1,
        },
        delayAfter: 2000,
      },
    ],
  },
  {
    id: 'create-screenshot-20-part2',
    name: '截图识别(20词-第二页)',
    group: '创建钱包',
    steps: [
      {
        label: '移动到截图位置(20词-2)',
        x: 259,
        y: 0,
        depth: 12,
        ocrCapture: {
          expectedWordCount: 20,
          mergeWithStored: true,
          allowPartial: false,
          requireBip39: false,
          sceneConfig: PRO2_OCR_SCENES.createWallet.mnemonic24Part2,
        },
        delayAfter: 2000,
      },
    ],
  },
  {
    id: 'create-screenshot-24-part1',
    name: '截图识别(24词-第一页)',
    group: '创建钱包',
    steps: [
      {
        label: '移动到截图位置(24词-1)',
        x: 259,
        y: 0,
        depth: 12,
        ocrCapture: {
          expectedWordCount: 24,
          mergeWithStored: true,
          allowPartial: true,
          requireBip39: false,
          sceneConfig: PRO2_OCR_SCENES.createWallet.mnemonic24Part1,
        },
        delayAfter: 2000,
      },
    ],
  },
  {
    id: 'create-screenshot-24-part2',
    name: '截图识别(24词-第二页)',
    group: '创建钱包',
    steps: [
      {
        label: '移动到截图位置(24词-2)',
        x: 259,
        y: 0,
        depth: 12,
        ocrCapture: {
          expectedWordCount: 24,
          mergeWithStored: true,
          allowPartial: false,
          requireBip39: true,
          sceneConfig: PRO2_OCR_SCENES.createWallet.mnemonic24Part2,
        },
        delayAfter: 2000,
      },
    ],
  },
  {
    id: 'create-continue',
    name: '继续备份',
    group: '创建钱包',
    steps: [
      { label: '点击继续', x: 212, y: 94, depth: 12 },
      // 备份确认弹层(验证/再次显示)出现需要约1秒，必须等它渲染完成再点验证
      { label: '开始核对', x: 214, y: 82, depth: 12, delayBefore: 1500 },
    ],
  },
  {
    id: 'create-verify-word',
    name: '验证单词',
    group: '创建钱包',
    steps: [
      {
        label: '验证单词',
        x: 259, y: 0, depth: 12,
        ocrVerify: {
          options: [
            { x: 213, y: 72, depth: 12 },
            { x: 213, y: 82, depth: 12 },
            { x: 213, y: 94, depth: 12 },
          ],
        },
        delayAfter: 2000,
      },
    ],
  },
  {
    id: 'create-verify-words',
    name: '验证单词(循环+自动重试)',
    group: '创建钱包',
    steps: [
      {
        // 循环答题直到不再出现验证题；遇到"助记词不正确"错误页
        // 自动点击 重试->验证 重新进入验证轮次
        label: '验证单词循环',
        x: 259, y: 0, depth: 12,
        ocrVerify: {
          loop: true,
          options: [
            { x: 213, y: 72, depth: 12 },
            { x: 213, y: 82, depth: 12 },
            { x: 213, y: 94, depth: 12 },
          ],
        },
        delayAfter: 2000,
      },
    ],
  },
  {
    id: 'create-final-continue-and-reset',
    name: '确认后继续并复位',
    group: '创建钱包',
    steps: [
      { label: '点击继续1', x: 212, y: 94, depth: 12, delayAfter: 600 },
      { label: '点击继续2', x: 212, y: 94, depth: 12, delayAfter: 600 },
      { label: '点击继续3', x: 212, y: 94, depth: 12, delayAfter: 600 },
      { label: '点击继续4', x: 212, y: 94, depth: 12, delayAfter: 800 },
      // pro2 验证完成后有"备份验证"选择页(仅 PIN / 助记词)，选中间行的"仅 PIN"
      { label: '备份验证-仅PIN', x: 213, y: 82, depth: 12, delayBefore: 1000, delayAfter: 1500 },
      { label: '复位', x: DEVICE_HOME_COORD.x, y: DEVICE_HOME_COORD.y, depth: 12 },
    ],
  },
  {
    // SLIP39 收尾：所有分片验证完成后没有"仅 PIN"备份验证选择页，直接继续到主页
    id: 'create-slip39-final-continue-and-reset',
    name: 'SLIP39确认后继续并复位',
    group: '创建钱包',
    steps: [
      { label: '点击继续1', x: 212, y: 94, depth: 12, delayAfter: 600 },
      { label: '点击继续2', x: 212, y: 94, depth: 12, delayAfter: 600 },
      { label: '点击继续3', x: 212, y: 94, depth: 12, delayAfter: 600 },
      { label: '点击继续4', x: 212, y: 94, depth: 12, delayAfter: 800 },
      { label: '复位', x: DEVICE_HOME_COORD.x, y: DEVICE_HOME_COORD.y, depth: 12 },
    ],
  },
  {
    id: 'create-slip39-share-confirm',
    name: 'SLIP39当前份额确认',
    group: '创建钱包',
    steps: [
      { label: '点击确认', x: 212, y: 94, depth: 12, delayBefore: 2000, delayAfter: 2000 },
    ],
  },
  {
    id: 'create-reset-only',
    name: '仅复位',
    group: '创建钱包',
    steps: [
      { label: '复位', x: DEVICE_HOME_COORD.x, y: DEVICE_HOME_COORD.y, depth: 12 },
    ],
  },


  // --------------------------------------------------------------------------
  // 助记词输入 (Mnemonic Word Input)
  // --------------------------------------------------------------------------
  {
    id: 'input-words-12-all',
    name: '12个词(all)',
    group: '助记词输入',
    steps: WORDS_12_STEPS,
  },
  {
    id: 'input-mnemonic-12-1',
    name: '12词-1 输入',
    group: '助记词输入',
    steps: [],
    mnemonicSource: { section: 'bip39', keys: ['mnemonic_12_1'], mode: 'single' },
  },
  {
    id: 'input-mnemonic-12-2',
    name: '12词-2 输入',
    group: '助记词输入',
    steps: [],
    mnemonicSource: { section: 'bip39', keys: ['mnemonic_12_2'], mode: 'single' },
  },
  {
    id: 'input-mnemonic-12-3',
    name: '12词-3 输入',
    group: '助记词输入',
    steps: [],
    mnemonicSource: { section: 'bip39', keys: ['mnemonic_12_3'], mode: 'single' },
  },
  {
    id: 'input-mnemonic-12-api',
    name: '签名方法 输入',
    group: '助记词输入',
    steps: [],
    mnemonicSource: { section: 'bip39', keys: ['mnemonic_12_api'], mode: 'single' },
  },
  {
    id: 'input-mnemonic-18-1',
    name: '18词-1 输入',
    group: '助记词输入',
    steps: [],
    mnemonicSource: { section: 'bip39', keys: ['mnemonic_18_1'], mode: 'single' },
  },
  {
    id: 'input-mnemonic-18-2',
    name: '18词-2 输入',
    group: '助记词输入',
    steps: [],
    mnemonicSource: { section: 'bip39', keys: ['mnemonic_18_2'], mode: 'single' },
  },
  {
    id: 'input-mnemonic-18-3',
    name: '18词-3 输入',
    group: '助记词输入',
    steps: [],
    mnemonicSource: { section: 'bip39', keys: ['mnemonic_18_3'], mode: 'single' },
  },
  {
    id: 'input-mnemonic-24-1',
    name: '24词-1 输入',
    group: '助记词输入',
    steps: [],
    mnemonicSource: { section: 'bip39', keys: ['mnemonic_24_1'], mode: 'single' },
  },
  {
    id: 'input-mnemonic-24-2',
    name: '24词-2 输入',
    group: '助记词输入',
    steps: [],
    mnemonicSource: { section: 'bip39', keys: ['mnemonic_24_2'], mode: 'single' },
  },
  {
    id: 'input-mnemonic-24-3',
    name: '24词-3 输入',
    group: '助记词输入',
    steps: [],
    mnemonicSource: { section: 'bip39', keys: ['mnemonic_24_3'], mode: 'single' },
  },
  {
    id: 'input-slip39-20-1',
    name: 'slip39-20词-1份 输入',
    group: '助记词输入',
    steps: [],
    mnemonicSource: { section: 'slip39', keys: ['slip39_20_1'], mode: 'single' },
  },
  {
    id: 'input-slip39-20-2-all',
    name: 'slip39-20词-2/3 输入',
    group: '助记词输入',
    steps: [],
    mnemonicSource: {
      section: 'slip39',
      keys: ['slip39_20_2_share1', 'slip39_20_2_share2', 'slip39_20_2_share3'],
      mode: 'shares-random',
      pickCount: 2,
    },
  },
  {
    id: 'input-slip39-20-16-all',
    name: 'slip39-20词-16/16 输入',
    group: '助记词输入',
    steps: [],
    mnemonicSource: {
      section: 'slip39',
      keys: [
        'slip39_20_16_share1', 'slip39_20_16_share2', 'slip39_20_16_share3', 'slip39_20_16_share4',
        'slip39_20_16_share5', 'slip39_20_16_share6', 'slip39_20_16_share7', 'slip39_20_16_share8',
        'slip39_20_16_share9', 'slip39_20_16_share10', 'slip39_20_16_share11', 'slip39_20_16_share12',
        'slip39_20_16_share13', 'slip39_20_16_share14', 'slip39_20_16_share15', 'slip39_20_16_share16',
      ],
      mode: 'shares-all',
    },
  },
  {
    id: 'input-slip39-33-1',
    name: 'slip39-33词-1份 输入',
    group: '助记词输入',
    steps: [],
    mnemonicSource: { section: 'slip39', keys: ['slip39_33_1'], mode: 'single' },
  },
  {
    id: 'input-slip39-33-2-all',
    name: 'slip39-33词-2/3(输入2份) 输入',
    group: '助记词输入',
    steps: [],
    mnemonicSource: {
      // 2-of-3：只提供了恢复所需的 2 份分片，按顺序全部输入
      section: 'slip39',
      keys: ['slip39_33_2_share1', 'slip39_33_2_share2'],
      mode: 'shares-all',
    },
  },

  // --------------------------------------------------------------------------
  // 完成 (Finish)
  // --------------------------------------------------------------------------
  {
    id: 'suffix-finish',
    name: '完成流程',
    group: '完成',
    steps: [
      { label: '点击继续1', x: 212, y: 94, depth: 12 },
      { label: '点击继续2', x: 212, y: 94, depth: 12 },
      { label: '点击继续3', x: 212, y: 94, depth: 12 },
      { label: '点击继续4', x: 212, y: 94, depth: 12, delayAfter: 2000 },
      { label: '复位', x: DEVICE_HOME_COORD.x, y: DEVICE_HOME_COORD.y, depth: 12 },
    ],
  },
  {
    id: 'suffix-finish-paced',
    name: '完成流程(慢速)',
    group: '完成',
    steps: [
      { label: '点击继续1', x: 212, y: 94, depth: 12, delayAfter: 2000 },
      { label: '点击继续2', x: 212, y: 94, depth: 12, delayAfter: 2000 },
      { label: '点击继续3', x: 212, y: 94, depth: 12, delayAfter: 2000 },
      { label: '点击继续4', x: 212, y: 94, depth: 12, delayAfter: 3000 },
      { label: '复位', x: DEVICE_HOME_COORD.x, y: DEVICE_HOME_COORD.y, depth: 12 },
    ],
  },

  // --------------------------------------------------------------------------
  // 设备管理 (Device Management)
  // --------------------------------------------------------------------------
  {
    id: 'reset-wallet-unlock-action',
    name: '解锁设备(点亮+PIN 1111)',
    group: '设备管理',
    steps: [
      // 第一步：双击点亮屏幕。熄屏状态下单击常无法唤醒，需连续两次点击；
      // 点在标题安全区，若屏幕本就亮着也不会误触
      { label: '点亮屏幕1', x: 213, y: 45, depth: 12, delayAfter: 500 },
      { label: '点亮屏幕2', x: 213, y: 45, depth: 12, delayAfter: 1500 },
      // 第二步：锁屏页点击"点击解锁"，弹出 PIN 键盘
      { label: '点击解锁', x: 212, y: 92, depth: 12, delayAfter: 1800 },
      // 第三步：输入 PIN 1111
      { label: 'PIN 1', x: NUMBER_COORDS['1'].x, y: NUMBER_COORDS['1'].y, depth: 12 },
      { label: 'PIN 2', x: NUMBER_COORDS['1'].x, y: NUMBER_COORDS['1'].y, depth: 12 },
      { label: 'PIN 3', x: NUMBER_COORDS['1'].x, y: NUMBER_COORDS['1'].y, depth: 12 },
      { label: 'PIN 4', x: NUMBER_COORDS['1'].x, y: NUMBER_COORDS['1'].y, depth: 12 },
      { label: 'Confirm', x: DEVICE_BUTTONS.confirm.x, y: DEVICE_BUTTONS.confirm.y, depth: 12, delayAfter: 2500 },
    ],
  },
  {
    id: 'reset-wallet-nav-action',
    name: '重置钱包流程(导航+重置)',
    group: '设备管理',
    steps: [
      // Enter reset flow from unlocked home (坐标经滑动调试面板实测校准)
      {
        label: '主页左滑进入面板',
        x: 225,
        y: 85,
        depth: 12,
        swipeTo: { x: 195, y: 85 },
        swipeSegments: 1,
        swipeHoldDelay: 300,
        delayBefore: 500,
        delayAfter: 1000,
      },
      { label: '点击设置', x: 225, y: 60, depth: 12, delayAfter: 800 },
      { label: '点击钱包', x: 199, y: 60, depth: 12, delayAfter: 800 },
      {
        label: '钱包页上滑',
        x: 225,
        y: 85,
        depth: 12,
        swipeTo: { x: 225, y: 50 },
        swipeSegments: 1,
        swipeHoldDelay: 300,
        delayAfter: 1000,
      },
      { label: '点击重置', x: 205, y: 93, depth: 12, delayAfter: 800 },
      { label: '二次确认重置', x: 223, y: 70, depth: 12, delayAfter: 1000 },
      { label: '勾选点击1', x: 196, y: 54, depth: 12, delayAfter: 600 },
      { label: '勾选点击2', x: 196, y: 64, depth: 12, delayAfter: 800 },
      {
        label: '滑动确认重置',
        x: 195,
        y: 95,
        depth: 12,
        swipeTo: { x: 225, y: 95 },
        swipeSegments: 1,
        swipeHoldDelay: 300,
        // 擦除数据需要数秒，等"重置完成"页渲染出来再点重启
        delayAfter: 5000,
      },
      // 重置完成页点击重启，等待设备重启完成
      { label: '点击重启', x: 212, y: 94, depth: 12, delayBefore: 1000, delayAfter: 10000 },
      // 复位机械臂：还原到 home 坐标
      { label: '复位', x: DEVICE_HOME_COORD.x, y: DEVICE_HOME_COORD.y, depth: 12 },
    ],
  },
  {
    id: 'reset-wallet-unlocked-action',
    name: '重置钱包流程(已解锁)',
    group: '设备管理',
    steps: [
      { label: 'Unlock swipe up', x: 50, y: 82, depth: 12, swipeTo: { x: 50, y: 38 }, swipeSegments: 8, swipeSegmentDelay: 80, swipeHoldDelay: 300, delayBefore: 500, delayAfter: 1800 },
      { label: 'Settings app', x: 50, y: 65, depth: 12, delayAfter: 600 },
      { label: 'Wallet section', x: 50, y: 55, depth: 12, delayAfter: 600 },
      { label: 'Swipe up', x: 35, y: 85, depth: 12, swipeTo: { x: 35, y: 70 }, delayAfter: 1000 },
      { label: 'Click 1', x: 50, y: 85, depth: 12, delayAfter: 800 },
      { label: 'Click 2', x: 50, y: 85, depth: 12, delayAfter: 800 },
      { label: 'Setting 1', x: 25, y: 44, depth: 12, delayAfter: 600 },
      { label: 'Setting 2', x: 25, y: 55, depth: 12, delayAfter: 900 },
      {
        label: 'Swipe right',
        x: 20,
        y: 75,
        depth: 12,
        swipeTo: { x: 60, y: 75 },
        swipeSegments: 6,
        swipeSegmentDelay: 70,
        swipeHoldDelay: 900,
        delayAfter: 7000,
      },
      { label: 'Confirm', x: 25, y: 85, depth: 12, delayAfter: 10000 },
      { label: 'Reset position', x: DEVICE_HOME_COORD.x, y: DEVICE_HOME_COORD.y, depth: 12 },
    ],
  },
];

/** PageAction lookup map for O(1) access */
const PAGE_ACTION_MAP = new Map<string, PageAction>(
  ALL_PAGE_ACTIONS.map((a) => [a.id, a])
);

// ============================================================================
// Sequence Definitions (composed from PageActions)
// ============================================================================

/**
 * Auto sequence definition.
 * Sequences are composed of ordered PageAction IDs.
 */
export interface AutoSequence {
  id: string;
  name: string;
  category: string;
  /** Ordered list of PageAction IDs that compose this sequence */
  actions: string[];
}

/** Import wallet shared action prefix */
const IMPORT_PREFIX: string[] = [
  'lang-zh', 'pin-1111', 'nav-continue-setup', 'nav-import', 'select-mnemonic',
];

/** Create wallet shared action prefix */
const CREATE_PREFIX: string[] = [
  'create-start-position', 'lang-zh', 'pin-1111', 'nav-continue-setup', 'nav-create',
];
/** Create 18/24/SLIP39 prefix: on the create/import selection page open the "更多" options sheet. */
const CREATE_PREFIX_MORE_OPTIONS: string[] = [
  'create-start-position', 'lang-zh', 'pin-1111', 'nav-continue-setup', 'create-more-options',
];
const CREATE_FLOW_SUFFIX: string[] = [
  'create-screenshot-12',
  'create-continue',
  'create-verify-words',
  'create-final-continue-and-reset',
];
const CREATE_FLOW_SUFFIX_18: string[] = [
  'create-generate-intros',
  'create-screenshot-18-part1',
  'create-mnemonic-scroll-10',
  'create-screenshot-18-part2',
  'create-continue',
  'create-verify-words',
  'create-final-continue-and-reset',
];
const CREATE_FLOW_SUFFIX_24: string[] = [
  'create-generate-intros',
  'create-screenshot-24-part1',
  'create-mnemonic-scroll-20',
  'create-screenshot-24-part2',
  'create-continue',
  'create-verify-words',
  'create-final-continue-and-reset',
];
const CREATE_FLOW_SUFFIX_SLIP39_TEMPLATE: string[] = [
  'create-generate-intros',
];
const CREATE_FLOW_SUFFIX_SLIP39_PER_SHARE: string[] = [
  'create-screenshot-20-part1',
  'create-slip39-mnemonic-scroll-15-slow',
  'create-screenshot-20-part2',
  'create-continue',
  'create-verify-words',
  'create-slip39-share-confirm',
];

function buildSlip39PerShareActions(shareCount: number): string[] {
  const loops = Math.max(1, Math.floor(shareCount));
  const actions: string[] = [];
  for (let i = 0; i < loops; i++) {
    actions.push(...CREATE_FLOW_SUFFIX_SLIP39_PER_SHARE);
  }
  return actions;
}

const ALL_SEQUENCES: AutoSequence[] = [
  // ============================================================================
  // 设备管理
  // ============================================================================
  {
    id: 'reset-wallet',
    name: '重置钱包',
    category: '设备管理',
    actions: ['reset-wallet-nav-action'],
  },
  {
    id: 'reset-wallet-locked',
    name: '重置钱包(锁定态)',
    category: '设备管理',
    actions: ['reset-wallet-unlock-action', 'reset-wallet-nav-action'],
  },
  {
    id: 'reset-wallet-unlocked',
    name: '重置钱包(已解锁)',
    category: '设备管理',
    actions: ['reset-wallet-unlocked-action'],
  },

  // ============================================================================
  // 创建钱包
  // ============================================================================
  {
    id: 'create-wallet',
    name: '创建新钱包(12词)',
    category: '创建钱包',
    actions: [...CREATE_PREFIX, ...CREATE_FLOW_SUFFIX],
  },
  {
    id: 'create-wallet-18',
    name: '创建新钱包(18词)',
    category: '创建钱包',
    actions: [...CREATE_PREFIX_MORE_OPTIONS, 'create-select-18-words', ...CREATE_FLOW_SUFFIX_18],
  },
  {
    id: 'create-wallet-24',
    name: '创建新钱包(24词)',
    category: '创建钱包',
    actions: [...CREATE_PREFIX_MORE_OPTIONS, 'create-select-24-words', ...CREATE_FLOW_SUFFIX_24],
  },
  {
    id: 'create-slip39-single-template',
    name: '创建SLIP39(单份模板)',
    category: '创建钱包',
    actions: [
      ...CREATE_PREFIX_MORE_OPTIONS,
      'create-more-options-scroll',
      'create-slip39-select-single',
      ...CREATE_FLOW_SUFFIX_SLIP39_TEMPLATE,
      ...buildSlip39PerShareActions(1),
      'create-slip39-final-continue-and-reset',
    ],
  },
  {
    id: 'create-slip39-multi-2of2-template',
    name: '创建SLIP39(多份模板 2/2)',
    category: '创建钱包',
    actions: [
      ...CREATE_PREFIX_MORE_OPTIONS,
      'create-more-options-scroll',
      'create-slip39-select-multi',
      'create-slip39-shares-2',
      'create-slip39-threshold-2',
      'create-slip39-config-continue',
      ...CREATE_FLOW_SUFFIX_SLIP39_TEMPLATE,
      ...buildSlip39PerShareActions(2),
      'create-slip39-final-continue-and-reset',
    ],
  },
  {
    id: 'create-slip39-multi-8of8-template',
    name: '创建SLIP39(多份模板 8/8)',
    category: '创建钱包',
    actions: [
      ...CREATE_PREFIX_MORE_OPTIONS,
      'create-more-options-scroll',
      'create-slip39-select-multi',
      'create-slip39-shares-8',
      'create-slip39-threshold-8',
      'create-slip39-config-continue',
      ...CREATE_FLOW_SUFFIX_SLIP39_TEMPLATE,
      ...buildSlip39PerShareActions(8),
      'create-slip39-final-continue-and-reset',
    ],
  },
  {
    id: 'create-slip39-multi-16of2-template',
    name: '创建SLIP39(多份模板 16/2)',
    category: '创建钱包',
    actions: [
      ...CREATE_PREFIX_MORE_OPTIONS,
      'create-more-options-scroll',
      'create-slip39-select-multi',
      'create-slip39-shares-16',
      'create-slip39-threshold-2',
      'create-slip39-config-continue',
      ...CREATE_FLOW_SUFFIX_SLIP39_TEMPLATE,
      ...buildSlip39PerShareActions(16),
      'create-slip39-final-continue-and-reset',
    ],
  },

  // ============================================================================
  // BIP39 12词
  // ============================================================================
  {
    id: 'words-12',
    name: '12个词(all)',
    category: 'BIP39 12词',
    actions: [...IMPORT_PREFIX, 'select-12-words', 'input-words-12-all', 'suffix-finish-paced'],
  },
  {
    id: 'one-normal-12',
    name: '12词-1',
    category: 'BIP39 12词',
    actions: [...IMPORT_PREFIX, 'select-12-words', 'input-mnemonic-12-1', 'suffix-finish-paced'],
  },
  {
    id: 'two-normal-12',
    name: '12词-2',
    category: 'BIP39 12词',
    actions: [...IMPORT_PREFIX, 'select-12-words', 'input-mnemonic-12-2', 'suffix-finish-paced'],
  },
  {
    id: 'three-normal-12',
    name: '12词-3',
    category: 'BIP39 12词',
    actions: [...IMPORT_PREFIX, 'select-12-words', 'input-mnemonic-12-3', 'suffix-finish-paced'],
  },
  {
    id: 'api-normal-12',
    name: '签名方法',
    category: 'BIP39 12词',
    actions: [...IMPORT_PREFIX, 'select-12-words', 'input-mnemonic-12-api', 'suffix-finish-paced'],
  },

  // ============================================================================
  // BIP39 18词
  // ============================================================================
  {
    id: 'one-normal-18',
    name: '18词-1',
    category: 'BIP39 18词',
    actions: [...IMPORT_PREFIX, 'select-18-words', 'input-mnemonic-18-1', 'suffix-finish-paced'],
  },
  {
    id: 'two-normal-18',
    name: '18词-2',
    category: 'BIP39 18词',
    actions: [...IMPORT_PREFIX, 'select-18-words', 'input-mnemonic-18-2', 'suffix-finish-paced'],
  },
  {
    id: 'three-normal-18',
    name: '18词-3',
    category: 'BIP39 18词',
    actions: [...IMPORT_PREFIX, 'select-18-words', 'input-mnemonic-18-3', 'suffix-finish-paced'],
  },

  // ============================================================================
  // BIP39 24词
  // ============================================================================
  {
    id: 'one-normal-24',
    name: '24词-1',
    category: 'BIP39 24词',
    actions: [...IMPORT_PREFIX, 'select-24-words', 'input-mnemonic-24-1', 'suffix-finish-paced'],
  },
  {
    id: 'two-normal-24',
    name: '24词-2',
    category: 'BIP39 24词',
    actions: [...IMPORT_PREFIX, 'select-24-words', 'input-mnemonic-24-2', 'suffix-finish-paced'],
  },
  {
    id: 'three-normal-24',
    name: '24词-3',
    category: 'BIP39 24词',
    actions: [...IMPORT_PREFIX, 'select-24-words', 'input-mnemonic-24-3', 'suffix-finish-paced'],
  },

  // ============================================================================
  // SLIP39 20词
  // ============================================================================
  {
    id: 'count20_one_normal',
    name: 'slip39-20词-1份',
    category: 'SLIP39 20词',
    actions: [...IMPORT_PREFIX, 'select-20-words', 'input-slip39-20-1', 'suffix-finish-paced'],
  },
  {
    id: 'count20_two_normal',
    name: 'slip39-20词-2/3',
    category: 'SLIP39 20词',
    actions: [...IMPORT_PREFIX, 'select-20-words', 'input-slip39-20-2-all', 'suffix-finish-paced'],
  },
  {
    id: 'count20_three_normal',
    name: 'slip39-20词-16/16',
    category: 'SLIP39 20词',
    actions: [...IMPORT_PREFIX, 'select-20-words', 'input-slip39-20-16-all', 'suffix-finish-paced'],
  },

  // ============================================================================
  // SLIP39 33词
  // ============================================================================
  {
    id: 'count33_one_normal',
    name: 'slip39-33词-1份',
    category: 'SLIP39 33词',
    actions: [...IMPORT_PREFIX, 'select-33-words', 'input-slip39-33-1', 'suffix-finish-paced'],
  },
  {
    id: 'count33_two_normal',
    name: 'slip39-33词-3/2',
    category: 'SLIP39 33词',
    actions: [...IMPORT_PREFIX, 'select-33-words', 'input-slip39-33-2-all', 'suffix-finish-paced'],
  },
];

const SUPPORTED_PRO2_SEQUENCE_IDS = new Set<string>([
  'reset-wallet',
  'reset-wallet-locked',
  'create-wallet',
  'create-wallet-18',
  'create-wallet-24',
  'create-slip39-single-template',
  'create-slip39-multi-2of2-template',
  'create-slip39-multi-8of8-template',
  'create-slip39-multi-16of2-template',
  'words-12',
  'one-normal-12',
  'two-normal-12',
  'three-normal-12',
  'api-normal-12',
  'one-normal-18',
  'two-normal-18',
  'three-normal-18',
  'one-normal-24',
  'two-normal-24',
  'three-normal-24',
  'count20_one_normal',
  'count20_two_normal',
  'count20_three_normal',
  'count33_two_normal',
]);

const VISIBLE_SEQUENCES: AutoSequence[] = ALL_SEQUENCES.filter((sequence) =>
  SUPPORTED_PRO2_SEQUENCE_IDS.has(sequence.id)
);

// ============================================================================
// PageAction Query Functions
// ============================================================================

/**
 * Gets a page action by ID.
 */
export function getPageAction(id: string): PageAction | undefined {
  return PAGE_ACTION_MAP.get(id);
}

/**
 * Gets all page actions.
 */
export function getAllPageActions(): PageAction[] {
  return [...ALL_PAGE_ACTIONS];
}

/**
 * Gets page actions filtered by group.
 */
export function getPageActionsByGroup(group: string): PageAction[] {
  return ALL_PAGE_ACTIONS.filter((a) => a.group === group);
}

/**
 * Gets all unique page action groups in display order.
 */
export function getAllPageActionGroups(): string[] {
  const seen = new Set<string>();
  const groups: string[] = [];
  for (const action of ALL_PAGE_ACTIONS) {
    if (!seen.has(action.group)) {
      seen.add(action.group);
      groups.push(action.group);
    }
  }
  return groups;
}

// ============================================================================
// Sequence Query Functions
// ============================================================================

/**
 * Gets a sequence by ID.
 */
export function getSequence(id: string): AutoSequence | undefined {
  return VISIBLE_SEQUENCES.find((s) => s.id === id);
}

/**
 * Gets all available sequence IDs.
 */
export function getAllSequenceIds(): string[] {
  return VISIBLE_SEQUENCES.map((s) => s.id);
}

/**
 * Gets all unique categories in display order.
 */
export function getAllCategories(): string[] {
  const seen = new Set<string>();
  const categories: string[] = [];
  for (const seq of VISIBLE_SEQUENCES) {
    if (!seen.has(seq.category)) {
      seen.add(seq.category);
      categories.push(seq.category);
    }
  }
  return categories;
}

/**
 * Gets sequences filtered by category.
 */
export function getSequencesByCategory(category: string): AutoSequence[] {
  return VISIBLE_SEQUENCES.filter((s) => s.category === category);
}

/**
 * Resolves a sequence's actions into a flat list of AutoSteps.
 * Each action ID is looked up in the PageAction registry and its steps are concatenated.
 */
export function getFullSteps(sequence: AutoSequence): AutoStep[] {
  const steps: AutoStep[] = [];
  for (const actionId of sequence.actions) {
    const action = PAGE_ACTION_MAP.get(actionId);
    if (action) {
      steps.push(...(action.buildSteps ? action.buildSteps() : action.steps));
    } else {
      console.warn(`[sequences] Unknown page action ID: ${actionId}`);
    }
  }
  return steps;
}

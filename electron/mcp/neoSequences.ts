/**
 * Neo Auto Operation Sequences
 *
 * Neo 与 Pro2 用例/坐标/OCR 场景基本一致，仅有以下差异（见下方 NEO_OVERRIDES）：
 *   ① 无指纹 → nav-continue-setup 少 1 步；
 *   ② 设置入口是磁贴网格 → reset 的「设置」坐标改为 (199,63)；
 *   ③ Hello→选语言 间隔太短 → lang-zh 把「点击Hello」后的等待加长到 1500ms；
 *   ④ 简体坐标不同 → lang-zh 选简体用 (210,69)；pro2 的 (212,66) 在 Neo 上会选到繁体。
 * 除这 3 个覆盖动作外，全部沿用 Pro2 的动作/序列/助记词解析。
 */
import * as pro2 from './pro2Sequences';

export type { AutoStep, AutoSequence, PageAction, MnemonicSource } from './pro2Sequences';
export {
  generateWordSteps,
  generateSlip39ShareSteps,
  pickRandomShares,
  DEVICE_HOME_COORD,
} from './pro2Sequences';

/**
 * Neo 与 Pro2 差异极小：除以下两点外，所有坐标/事件与 Pro2 完全一致，
 * 因此只覆盖 2 个动作，其余（含 lang-zh 的手动设置/命名/简体坐标/Hello 等待）
 * 全部沿用 Pro2。
 *   ① 无指纹：`nav-continue-setup` 比 Pro2 少 1 步（去掉跳过指纹的其中一步）。
 *   ② 设置入口是磁贴网格：`reset-wallet-nav-action` 只把「设置」坐标改成 (199,63)，
 *      其余重置步骤全部同 Pro2。
 * 注：lang-zh 的「手动设置/命名」两页、简体 (210,69)、Hello 后 1500ms 等待，
 * Pro2 与 Neo 一致，已并入 Pro2 的 lang-zh，Neo 不再单独覆盖。
 */

/**
 * Neo nav-continue-setup：坐标同 Pro2 (212,94)，仅比 Pro2 少 1 步
 * （Pro2 为 继续 + 跳过指纹 + 跳过指纹确认 共 3 步；Neo 无指纹，去掉 1 步留 2 步）。
 */
const NEO_NAV_CONTINUE_SETUP: pro2.PageAction = {
  id: 'nav-continue-setup',
  name: '继续x2(Neo无指纹)',
  group: '初始设置',
  steps: [
    { label: '提示页面继续', x: 212, y: 94, depth: 12, delayAfter: 500 },
    { label: '继续(Neo无指纹)', x: 212, y: 94, depth: 12, delayAfter: 500 },
  ],
};

/**
 * Neo reset-wallet-nav-action：坐标完全同 Pro2，唯一差异是「设置」入口——
 * Neo 主页左滑出的面板里「设置」是磁贴网格左列中间 (199,63)（Pro2 为列表项 (225,60)）。
 * 其余步骤（左滑、钱包、上滑、重置、二次确认、两个勾选、滑动确认、重启）全部同 Pro2。
 */
const NEO_RESET_WALLET_NAV_ACTION: pro2.PageAction = {
  id: 'reset-wallet-nav-action',
  name: '重置钱包流程(Neo:仅改设置入口)',
  group: '设备管理',
  steps: [
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
    { label: '点击设置(Neo磁贴左中)', x: 199, y: 63, depth: 12, delayAfter: 800 },
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
    { label: '勾选点击1', x: 197, y: 54, depth: 12, delayAfter: 600 },
    { label: '勾选点击2', x: 196, y: 64, depth: 12, delayAfter: 800 },
    {
      label: '滑动确认重置',
      x: 195,
      y: 95,
      depth: 12,
      swipeTo: { x: 225, y: 95 },
      swipeSegments: 1,
      swipeHoldDelay: 300,
      delayAfter: 5000,
    },
    { label: '点击重启', x: 212, y: 94, depth: 12, delayBefore: 1000, delayAfter: 10000 },
    { label: '复位', x: pro2.DEVICE_HOME_COORD.x, y: pro2.DEVICE_HOME_COORD.y, depth: 12 },
  ],
};

/** Neo 覆盖的动作表：id -> Neo 版动作（仅这三项与 Pro2 不同，其余全部沿用 Pro2） */
const NEO_OVERRIDES: Record<string, pro2.PageAction> = {
  'nav-continue-setup': NEO_NAV_CONTINUE_SETUP,
  'reset-wallet-nav-action': NEO_RESET_WALLET_NAV_ACTION,
};

/** Neo 页面动作表 = Pro2 全部动作，只替换 NEO_OVERRIDES 中的动作 */
const NEO_PAGE_ACTION_MAP = new Map<string, pro2.PageAction>(
  pro2.getAllPageActions().map((action) => [
    action.id,
    NEO_OVERRIDES[action.id] ?? action,
  ])
);

export function getPageAction(id: string): pro2.PageAction | undefined {
  return NEO_PAGE_ACTION_MAP.get(id);
}

export function getAllPageActions(): pro2.PageAction[] {
  return [...NEO_PAGE_ACTION_MAP.values()];
}

// 序列列表与 Pro2 完全相同，直接复用 Pro2 的查询函数
export const getSequence = pro2.getSequence;
export const getAllSequenceIds = pro2.getAllSequenceIds;
export const getAllCategories = pro2.getAllCategories;
export const getSequencesByCategory = pro2.getSequencesByCategory;

/** 展开序列为步骤（预览用）：用 Neo 的动作表，其余逻辑同 Pro2 */
export function getFullSteps(sequence: pro2.AutoSequence): pro2.AutoStep[] {
  const steps: pro2.AutoStep[] = [];
  for (const actionId of sequence.actions) {
    const action = NEO_PAGE_ACTION_MAP.get(actionId);
    if (action) {
      steps.push(...(action.buildSteps ? action.buildSteps() : action.steps));
    } else {
      console.warn(`[neo-sequences] Unknown page action ID: ${actionId}`);
    }
  }
  return steps;
}

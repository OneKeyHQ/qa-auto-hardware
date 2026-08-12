/**
 * Neo Auto Operation Sequences
 *
 * Neo 与 Pro2 完全一致（用例、坐标、OCR 场景都一样），唯一区别：
 * Neo 不支持指纹，初始设置流程里没有"跳过指纹"页面。
 * 因此本模块复用 Pro2 的一切，只覆盖 `nav-continue-setup` 动作
 * （去掉跳过指纹的两步），其余动作/序列/助记词解析全部沿用 Pro2。
 */
import * as pro2 from './pro2Sequences';

export type { AutoStep, AutoSequence, PageAction, MnemonicSource } from './pro2Sequences';
export {
  generateWordSteps,
  generateSlip39ShareSteps,
  pickRandomShares,
  DEVICE_HOME_COORD,
} from './pro2Sequences';

/** Neo 初始设置继续：没有指纹页，只点一次"继续"（对比 Pro2 少了跳过指纹两步） */
const NEO_NAV_CONTINUE_SETUP: pro2.PageAction = {
  id: 'nav-continue-setup',
  name: '继续(Neo无指纹)',
  group: '初始设置',
  steps: [
    { label: '提示页面继续', x: 212, y: 94, depth: 12, delayAfter: 500 },
  ],
};

/** Neo 页面动作表 = Pro2 全部动作，只把 nav-continue-setup 换成无指纹版 */
const NEO_PAGE_ACTION_MAP = new Map<string, pro2.PageAction>(
  pro2.getAllPageActions().map((action) => [
    action.id,
    action.id === 'nav-continue-setup' ? NEO_NAV_CONTINUE_SETUP : action,
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

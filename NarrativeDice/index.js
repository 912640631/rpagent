import { randomInt } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const DEFAULT_STATE_PATH = resolve('NarrativeDice/.local/session.json');

export class DiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DiceError';
    this.code = code;
  }
}

export function initialState() {
  return { version: 1, hope: 2, fear: 0, history: [] };
}

function assertState(state) {
  if (
    !state || state.version !== 1 ||
    !Number.isInteger(state.hope) || state.hope < 0 || state.hope > 6 ||
    !Number.isInteger(state.fear) || state.fear < 0 || state.fear > 12 ||
    !Array.isArray(state.history)
  ) {
    throw new DiceError('INVALID_STATE', '状态文件格式或资源数值无效');
  }
  return state;
}

function validateRoll(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new DiceError('INVALID_ROLL', '判定参数必须是对象');
  }
  const { difficulty, modifier = 0, useHopeAdvantage = false } = input;
  if (!Number.isSafeInteger(difficulty) || difficulty < 1) {
    throw new DiceError('INVALID_DIFFICULTY', '难度必须是大于零的安全整数');
  }
  if (!Number.isSafeInteger(modifier)) {
    throw new DiceError('INVALID_MODIFIER', '修正值必须是安全整数');
  }
  if (typeof useHopeAdvantage !== 'boolean') {
    throw new DiceError('INVALID_ADVANTAGE', 'useHopeAdvantage 必须是布尔值');
  }
  return { difficulty, modifier, useHopeAdvantage };
}

function checkedDie(rollDie) {
  const value = rollDie();
  if (!Number.isInteger(value) || value < 1 || value > 12) {
    throw new DiceError('INVALID_DIE', '骰子函数必须返回 1 至 12 的整数');
  }
  return value;
}

export function resolveRoll(state, input, rollDie = () => randomInt(1, 13)) {
  assertState(state);
  const { difficulty, modifier, useHopeAdvantage } = validateRoll(input);
  if (useHopeAdvantage && state.hope < 2) {
    throw new DiceError('INSUFFICIENT_HOPE', '希望值不足 2 点，无法购买优势');
  }

  const hopeDie = checkedDie(rollDie);
  const fearDie = checkedDie(rollDie);
  const advantageBonus = useHopeAdvantage ? 3 : 0;
  const total = hopeDie + fearDie + modifier + advantageBonus;
  if (!Number.isSafeInteger(total)) {
    throw new DiceError('INVALID_TOTAL', '判定总和超出安全整数范围');
  }

  const critical = hopeDie === fearDie;
  const success = critical || total >= difficulty;
  const bearing = critical || hopeDie > fearDie ? 'hope' : 'fear';
  const outcome = critical ? 'critical_success' : `${success ? 'success' : 'failure'}_${bearing}`;
  const hopeSpent = useHopeAdvantage ? 2 : 0;
  const hopeAfterPayment = state.hope - hopeSpent;
  const hopeGained = bearing === 'hope' ? Math.min(1, 6 - hopeAfterPayment) : 0;
  const fearGained = bearing === 'fear' ? Math.min(1, 12 - state.fear) : 0;
  const next = {
    ...state,
    hope: hopeAfterPayment + hopeGained,
    fear: state.fear + fearGained,
    history: [...state.history],
  };
  const result = {
    outcome,
    success,
    critical,
    bearing,
    dice: { hope: hopeDie, fear: fearDie },
    difficulty,
    modifier,
    advantageBonus,
    total,
    hopeSpent,
    hopeGained,
    fearGained,
    immediateComplication: outcome === 'success_fear',
    consequence: outcome === 'success_fear' ? 'minor_complication'
      : outcome === 'failure_hope' ? 'light'
        : outcome === 'failure_fear' ? 'serious' : 'none',
    extraBenefit: critical,
    initiative: bearing === 'hope' && success ? 'player' : 'gm',
    resources: { hope: next.hope, fear: next.fear },
  };
  next.history.push({
    id: next.history.length + 1,
    type: 'roll',
    at: new Date().toISOString(),
    result,
  });
  return { state: next, result };
}

export function resolveFearSpend(state) {
  assertState(state);
  if (state.fear < 2) {
    throw new DiceError('INSUFFICIENT_FEAR', '绝望值不足 2 点');
  }
  const next = {
    ...state,
    fear: state.fear - 2,
    history: [...state.history],
  };
  const result = { fearSpent: 2, resources: { hope: next.hope, fear: next.fear } };
  next.history.push({
    id: next.history.length + 1,
    type: 'spend_fear',
    at: new Date().toISOString(),
    result,
  });
  return { state: next, result };
}

async function saveState(statePath, state) {
  await mkdir(dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.${randomInt(0, 0x100000000).toString(16)}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
    await rename(temporaryPath, statePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function loadState(statePath) {
  try {
    return assertState(JSON.parse(await readFile(statePath, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') {
      const state = initialState();
      await saveState(statePath, state);
      return state;
    }
    if (error instanceof SyntaxError) {
      throw new DiceError('INVALID_STATE', '状态文件不是有效 JSON');
    }
    throw error;
  }
}

export function createEngine({ statePath = DEFAULT_STATE_PATH, rollDie } = {}) {
  const path = resolve(statePath);
  return {
    async status() {
      return loadState(path);
    },
    async roll(input) {
      const current = await loadState(path);
      const { state, result } = resolveRoll(current, input, rollDie);
      await saveState(path, state);
      return result;
    },
    async spendFear() {
      const current = await loadState(path);
      const { state, result } = resolveFearSpend(current);
      await saveState(path, state);
      return result;
    },
    async reset() {
      const state = initialState();
      await saveState(path, state);
      return state;
    },
  };
}

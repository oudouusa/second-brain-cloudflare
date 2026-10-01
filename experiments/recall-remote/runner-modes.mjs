export const providerModes = Object.freeze(['healthy', 'quota', 'embedding-failure', 'vector-failure']);

// 条件内のwarmup・反復数を維持し、日次枠内でmode単位に分割する。
export function selectModes(budget) {
  if (!budget || !Object.hasOwn(budget, 'modes')) return [...providerModes];
  const modes = budget.modes;
  if (!Array.isArray(modes) || !modes.length || new Set(modes).size !== modes.length
    || modes.some(mode => !providerModes.includes(mode))) throw new Error('予算のmode指定が不正');
  return providerModes.filter(mode => modes.includes(mode));
}

// ==================== init 交互向导 ====================

// 根据已占用 id 列表给出不冲突的默认 id（纯函数，便于单测）
export function suggestId(existingIds: string[], provider: string): string {
  const base = `${provider}-main`;
  if (!existingIds.includes(base)) return base;
  let n = 2;
  while (existingIds.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

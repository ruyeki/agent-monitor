// The horizontal bar of a crew-tree elbow: from the parent's centre to the centre of the farthest child that has a
// recorded parent. Children without one (`linked` false) get no stub and are never spanned.
// kids = [{ x, linked }] (x = the child's centre); returns { left, right } or null when no child is linked.
export function barSpan(parentX, kids) {
  const xs = (kids || []).filter((k) => k && k.linked && Number.isFinite(k.x)).map((k) => k.x);
  if (!xs.length || !Number.isFinite(parentX)) return null;
  return { left: Math.min(parentX, ...xs), right: Math.max(parentX, ...xs) };
}

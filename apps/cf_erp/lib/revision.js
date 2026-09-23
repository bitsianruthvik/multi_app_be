/** A → B … Z → AA; 0 → 1; R0 → R1; 01 → 02; anything else gets ".1". Labels only — the row never changes (Q2). */
export function nextRevision(current) {
  if (!current) return 'A';
  if (/^[A-Z]+$/.test(current)) {
    const chars = current.split('');
    for (let i = chars.length - 1; i >= 0; i--) {
      if (chars[i] !== 'Z') { chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1); return chars.join(''); }
      chars[i] = 'A';
    }
    return `A${chars.join('')}`;
  }
  const m = /^(.*?)(\d+)$/.exec(current);
  if (m) return m[1] + String(Number(m[2]) + 1).padStart(m[2].length, '0');
  return `${current}.1`;
}

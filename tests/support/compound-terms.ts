/**
 * The largest compound SELECT (UNION / UNION ALL / INTERSECT / EXCEPT chain) in a piece of SQL, in terms.
 *
 * workerd's SQLite (D1, `wrangler d1 migrations apply --local`) fails "too many terms in compound SELECT"
 * from the sixth term; node:sqlite allows 500, so a unit test over node:sqlite cannot see it. Operators are
 * counted per parenthesis level and reset at each `;`, so a subquery's own chain is counted on its own.
 */
export function maxCompoundTerms(sql: string): number {
  const text = sql.replace(/--[^\n]*/g, '').replace(/'(?:[^']|'')*'/g, "''");
  const stack: number[] = [0];
  let max = 0;
  for (const m of text.matchAll(/\(|\)|;|\b(?:UNION|INTERSECT|EXCEPT)\b/gi)) {
    const token = m[0].toUpperCase();
    if (token === '(') stack.push(0);
    else if (token === ')') stack.pop();
    else if (token === ';') stack[stack.length - 1] = 0;
    else {
      const next = (stack[stack.length - 1] ?? 0) + 1;
      stack[stack.length - 1] = next;
      max = Math.max(max, next + 1);
    }
    if (stack.length === 0) stack.push(0);
  }
  return max;
}

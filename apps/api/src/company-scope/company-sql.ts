import { ForbiddenException } from '@nestjs/common';

/** Raw SELECTs use scoped derived tables, including joins, unions and subqueries.
 * Values remain bound parameters; identifiers come only from Prisma metadata.
 * Locking reads lock inside the derived table as well as in the outer statement.
 */
export function scopeCompanySql(sql: string, companyId: bigint, tables: Set<string>, write = false): string {
  const id = companyId.toString();
  if (write) {
    // The sole business raw-write path is the master-product bulk update.
    if (!/^\s*UPDATE\s+`?master_products`?\s+SET\b/i.test(sql) || !/\bWHERE\b/i.test(sql)
      || /;|--|\/\*/.test(sql)) throw new ForbiddenException('此原生写入不支持公司范围');
    return `${sql.trim()} AND company_id = ${id}`;
  }
  if (!/^\s*(SELECT|WITH)\b/i.test(sql) || /;/.test(sql)) {
    throw new ForbiddenException('此原生查询不支持公司范围');
  }
  const lock = /\bFOR\s+UPDATE\b/i.test(sql) ? ' FOR UPDATE' : '';
  // Tokenize strings/comments before matching FROM/JOIN so text values are never rewritten.
  const tokens = sql.match(/'(?:''|\\.|[^'\\])*'|"(?:""|\\.|[^"\\])*"|--[^\n]*|\/\*[\s\S]*?\*\/|`[^`]+`|[A-Za-z_][\w$]*|\s+|./g) ?? [];
  const keywords = new Set(['where','on','join','left','right','inner','outer','cross','group','order','limit','for','union','having','set','offset','use','force','ignore']);
  let depth = 0;
  const fromLevels = new Set<number>();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '(') depth++;
    if (tokens[i] === ')') { fromLevels.delete(depth); depth--; }
    if (/^(where|group|order|having|union|for|limit)$/i.test(tokens[i])) fromLevels.delete(depth);
    if (tokens[i] === ',' && fromLevels.has(depth)) throw new ForbiddenException('此 SQL 表引用不支持公司范围');
    if (/^from$/i.test(tokens[i])) fromLevels.add(depth);
    if (!/^(from|join)$/i.test(tokens[i])) continue;
    let j = i + 1;
    while (/^\s+$/.test(tokens[j] ?? '')) j++;
    const table = (tokens[j] ?? '').replace(/`/g, '');
    let k = j + 1;
    while (/^\s+$/.test(tokens[k] ?? '')) k++;
    if (tokens[k] === '.' || tokens[k] === ',') throw new ForbiddenException('此 SQL 表引用不支持公司范围');
    if (!tables.has(table)) continue;
    const alias = tokens[k] && (/^`/.test(tokens[k]) || (/^[a-z_]\w*$/i.test(tokens[k]) && !keywords.has(tokens[k].toLowerCase())));
    tokens[j] = `(SELECT * FROM \`${table}\` WHERE company_id = ${id}${lock})${alias ? '' : ` AS \`${table}\``}`;
  }
  return tokens.join('');
}

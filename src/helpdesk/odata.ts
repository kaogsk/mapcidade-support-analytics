// The subset of OData query options the ticketing API supports and the sync uses:
// $filter (comparisons joined by and/or/not, parentheses), $select, $expand,
// $orderby, $top, $skip. A small recursive-descent parser so the fake API rejects
// what the real one rejects — notably a date literal WITHOUT a timezone (HTTP 400),
// which is why the client always sends "...T20:00:00.000z".

export class ODataError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export type CmpOp = "eq" | "ne" | "gt" | "ge" | "lt" | "le";
export type Literal =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "datetime"; value: number }
  | { kind: "bool"; value: boolean }
  | { kind: "null" };

export type FilterNode =
  | { type: "and" | "or"; left: FilterNode; right: FilterNode }
  | { type: "not"; expr: FilterNode }
  | { type: "cmp"; op: CmpOp; field: string; value: Literal };

type Token =
  | { t: "lparen" | "rparen" }
  | { t: "word"; v: string }
  | { t: "lit"; v: Literal };

const CMP_OPS = new Set(["eq", "ne", "gt", "ge", "lt", "le"]);
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,7})?)?(?:[zZ]|[+-]\d{2}:\d{2})?$/;
const HAS_TZ_RE = /(?:[zZ]|[+-]\d{2}:\d{2})$/;

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === "(") {
      out.push({ t: "lparen" });
      i++;
    } else if (c === ")") {
      out.push({ t: "rparen" });
      i++;
    } else if (c === "'") {
      let v = "";
      i++;
      for (;;) {
        if (i >= src.length) throw new ODataError("unterminated string literal");
        if (src[i] === "'") {
          if (src[i + 1] === "'") {
            v += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        v += src[i++];
      }
      out.push({ t: "lit", v: { kind: "string", value: v } });
    } else {
      let j = i;
      while (j < src.length && !/[\s()]/.test(src[j])) j++;
      const word = src.slice(i, j);
      i = j;
      out.push(classifyWord(word));
    }
  }
  return out;
}

function classifyWord(w: string): Token {
  if (/^\d{4}-\d{2}-\d{2}T/.test(w)) {
    if (!DATETIME_RE.test(w)) throw new ODataError(`malformed DateTimeOffset literal: ${w}`);
    if (!HAS_TZ_RE.test(w)) {
      throw new ODataError(`The DateTimeOffset literal '${w}' must carry a time zone (e.g. 'z' or '-03:00')`);
    }
    return { t: "lit", v: { kind: "datetime", value: new Date(w.replace(/z$/, "Z")).getTime() } };
  }
  if (/^-?\d+(\.\d+)?$/.test(w)) return { t: "lit", v: { kind: "number", value: Number(w) } };
  if (w === "null") return { t: "lit", v: { kind: "null" } };
  if (w === "true" || w === "false") return { t: "lit", v: { kind: "bool", value: w === "true" } };
  return { t: "word", v: w };
}

export function parseFilter(src: string): FilterNode {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const isWord = (v: string) => {
    const tk = peek();
    return tk?.t === "word" && tk.v === v;
  };

  function orExpr(): FilterNode {
    let left = andExpr();
    while (isWord("or")) {
      pos++;
      left = { type: "or", left, right: andExpr() };
    }
    return left;
  }
  function andExpr(): FilterNode {
    let left = unary();
    while (isWord("and")) {
      pos++;
      left = { type: "and", left, right: unary() };
    }
    return left;
  }
  function unary(): FilterNode {
    if (isWord("not")) {
      pos++;
      return { type: "not", expr: unary() };
    }
    return primary();
  }
  function primary(): FilterNode {
    const tk = peek();
    if (!tk) throw new ODataError("unexpected end of $filter");
    if (tk.t === "lparen") {
      pos++;
      const e = orExpr();
      if (peek()?.t !== "rparen") throw new ODataError("expected ')' in $filter");
      pos++;
      return e;
    }
    if (tk.t !== "word" || !/^[A-Za-z_][\w/]*$/.test(tk.v)) throw new ODataError("expected a property name in $filter");
    const field = tk.v;
    pos++;
    const opTok = peek();
    if (opTok?.t !== "word" || !CMP_OPS.has(opTok.v)) throw new ODataError(`expected a comparison operator after '${field}'`);
    pos++;
    const lit = peek();
    if (lit?.t !== "lit") throw new ODataError(`expected a literal after '${field} ${opTok.v}'`);
    pos++;
    return { type: "cmp", op: opTok.v as CmpOp, field, value: lit.v };
  }

  const ast = orExpr();
  if (pos !== tokens.length) throw new ODataError("unexpected trailing tokens in $filter");
  return ast;
}

/** Read a (possibly nested with "/") property; naive date strings are UTC instants. */
function readField(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split("/")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function toMs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const ms = new Date(HAS_TZ_RE.test(v) ? v : `${v}Z`).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function compare(op: CmpOp, a: number | string | boolean, b: number | string | boolean): boolean {
  switch (op) {
    case "eq":
      return a === b;
    case "ne":
      return a !== b;
    case "gt":
      return a > b;
    case "ge":
      return a >= b;
    case "lt":
      return a < b;
    case "le":
      return a <= b;
  }
}

export function evaluate(node: FilterNode, obj: Record<string, unknown>): boolean {
  switch (node.type) {
    case "and":
      return evaluate(node.left, obj) && evaluate(node.right, obj);
    case "or":
      return evaluate(node.left, obj) || evaluate(node.right, obj);
    case "not":
      return !evaluate(node.expr, obj);
    case "cmp": {
      const raw = readField(obj, node.field);
      const lit = node.value;
      if (lit.kind === "null") {
        const isNull = raw == null;
        return node.op === "eq" ? isNull : node.op === "ne" ? !isNull : false;
      }
      if (raw == null) return node.op === "ne";
      if (lit.kind === "datetime") {
        const ms = toMs(raw);
        return ms != null && compare(node.op, ms, lit.value);
      }
      if (lit.kind === "number") return typeof raw === "number" && compare(node.op, raw, lit.value);
      if (lit.kind === "bool") return typeof raw === "boolean" && compare(node.op, raw, lit.value);
      return typeof raw === "string" && compare(node.op, raw, lit.value);
    }
  }
}

/** Top-level names of a $select / $expand list (nested options in parentheses are skipped). */
export function topLevelNames(list: string | null | undefined): string[] {
  if (!list) return [];
  const names: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      names.push(cur);
      cur = "";
      continue;
    }
    if (depth === 0 && ch !== ")") cur += ch;
  }
  names.push(cur);
  if (depth !== 0) throw new ODataError("unbalanced parentheses in $select/$expand");
  return names.map((n) => n.trim()).filter(Boolean);
}

export interface OrderBy {
  field: string;
  desc: boolean;
}

export function parseOrderBy(src: string | null | undefined): OrderBy | null {
  if (!src) return null;
  const m = /^\s*([A-Za-z_]\w*)(?:\s+(asc|desc))?\s*$/.exec(src);
  if (!m) throw new ODataError(`unsupported $orderby: ${src}`);
  return { field: m[1], desc: m[2] === "desc" };
}

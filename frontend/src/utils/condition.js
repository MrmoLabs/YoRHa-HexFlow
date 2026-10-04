/**
 * R26（PLAN §8.58）序列步骤条件 —— 受限表达式求值（**无 eval / 无 Function / 无属性反射**）。
 *
 * 与 BE `backend/core/condition.py` **逐行同语义**：一次比较 = `左操作数 运算符 右操作数`，
 * 运算符恰 6 个（`==` `!=` `>=` `<=` `>` `<` + 关键字 `in`），操作数 = 数字字面量
 * （十进制 / `0x` / `0b` / 小数）、字符串字面量（单双引号，反斜杠 = 原样取下一字符）、
 * 关键字 `true`/`false`/`null`（大小写不敏感）、变量名、数组字面量 `[a, b]`。
 * **没有算术、没有括号、没有布尔连接、没有函数调用** —— 多一个字符就报错。
 *
 * 变量名是**一整个裸词**（可含 `.`、`-`、中文），运行期由 BE 供一张扁平字符串键的变量表，
 * 查表 = **整串精确匹配**，不做点号下钻。本模块在 FE 的职责：① 保存前就地校验语法
 * （`checkCondition` → 属性面板 / 步骤编辑器就近红字），② 与 BE 同一套求值口径被
 * 共享向量 `vectors/condition.json` 逐行钉死（含**错误文案逐字相同**）。
 *
 * 双端纪律：改一必改二（`condition.test.js` ↔ `test_condition.py` 同读一张向量表）。
 */

export const MAX_CONDITION_LEN = 200;
export const MAX_TOKENS = 64;
export const MAX_ARRAY_ITEMS = 32;

/** 拍板运算符集（`in` 走关键字，大小写不敏感） */
export const OPS = ['==', '!=', '>=', '<=', '>', '<'];
/** 关键字（大小写不敏感） */
const KEYWORDS = ['true', 'false', 'null', 'in'];
/** 缺运算符时的固定文案（BE 同字面量） */
const MISSING_OP = '缺少比较运算符（支持 == != >= <= > < in）';

/** 数字字面量（`0x` / `0b` / 十进制整数 / 小数 / 科学计数） */
const NUMBER_RE = /^-?(?:0[xX][0-9a-fA-F]+|0[bB][01]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/;

export class ConditionError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConditionError';
    }
}

/** 变量值 → 类型名（**错误文案跨端逐字相同**，故只用这 5 种固定名） */
function kindOf(value) {
    if (value === null) return 'null';
    if (typeof value === 'boolean') return '布尔';
    if (typeof value === 'number') return '数字';
    if (typeof value === 'string') return '字符串';
    if (Array.isArray(value)) return '数组';
    return '未知';
}

/** 字面量文本 → 数值（`0x` / `0b` / 十进制整数 / 小数） */
function numberOf(text) {
    const negative = text.startsWith('-');
    const body = negative ? text.slice(1) : text;
    const low = body.toLowerCase();
    let value;
    if (low.startsWith('0x')) value = parseInt(body.slice(2), 16);
    else if (low.startsWith('0b')) value = parseInt(body.slice(2), 2);
    else if (body.includes('.') || low.includes('e')) value = parseFloat(body);
    else value = parseInt(body, 10);
    return negative ? -value : value;
}

const DELIMS = new Set([' ', '\t', '\r', '\n', '(', ')', '[', ']', ',', '"', "'"]);

/**
 * 词法：空白忽略；运算符先于裸词；裸词吃到分隔符为止。
 * 按 **码点**（`Array.from`）迭代，位置口径与 Python 逐字符一致 →
 * 错误文案里的 `位置 N` 两端同值。
 */
function lex(src) {
    const chars = Array.from(src);
    const out = [];
    let i = 0;
    const n = chars.length;
    while (i < n) {
        const ch = chars[i];
        if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
            i += 1;
            continue;
        }
        const two = chars[i] + (chars[i + 1] ?? '');
        if (two === '==' || two === '!=' || two === '>=' || two === '<=') {
            out.push({ kind: 'op', value: two, pos: i });
            i += 2;
            continue;
        }
        if (ch === '>' || ch === '<') {
            out.push({ kind: 'op', value: ch, pos: i });
            i += 1;
            continue;
        }
        if (ch === '[' || ch === ']') {
            out.push({ kind: ch, value: ch, pos: i });
            i += 1;
            continue;
        }
        if (ch === '(' || ch === ')') {
            // 拍板不含括号（无布尔连接）→ 不给「分组」留口子，直接判非法
            throw new ConditionError(`无法识别的记号：位置 ${i}`);
        }
        if (ch === ',') {
            out.push({ kind: ',', value: ch, pos: i });
            i += 1;
            continue;
        }
        if (ch === '"' || ch === "'") {
            let j = i + 1;
            const buf = [];
            while (j < n && chars[j] !== ch) {
                if (chars[j] === '\\' && j + 1 < n) {
                    buf.push(chars[j + 1]); // 反斜杠 = 原样取下一字符（双端同口径）
                    j += 2;
                    continue;
                }
                buf.push(chars[j]);
                j += 1;
            }
            if (j >= n) throw new ConditionError(`字符串未闭合：位置 ${i}`);
            out.push({ kind: 'str', value: buf.join(''), pos: i });
            i = j + 1;
            continue;
        }
        const digitStart = (ch >= '0' && ch <= '9')
            || (ch === '-' && i + 1 < n && chars[i + 1] >= '0' && chars[i + 1] <= '9');
        if (digitStart) {
            const rest = chars.slice(i).join('');
            const m = NUMBER_RE.exec(rest);
            if (!m) throw new ConditionError(`无法识别的记号：位置 ${i}`);
            out.push({ kind: 'num', value: numberOf(m[0]), pos: i });
            i += m[0].length; // 正则只匹配 ASCII，长度即码点数
            continue;
        }
        // 裸词（变量名 / 关键字）
        let j = i;
        while (j < n && !DELIMS.has(chars[j])) j += 1;
        const word = chars.slice(i, j).join('');
        if (!word) throw new ConditionError(`无法识别的记号：位置 ${i}`); // 防御：分隔符必被上面的分支吃掉
        const low = word.toLowerCase();
        if (KEYWORDS.includes(low)) out.push({ kind: 'kw', value: low, pos: i });
        else out.push({ kind: 'var', value: word, pos: i });
        i = j;
    }
    return out;
}

class Parser {
    constructor(tokens, src) {
        this.tokens = tokens;
        this.src = src;
        this.i = 0;
    }

    peek() {
        return this.i < this.tokens.length ? this.tokens[this.i] : null;
    }

    take() {
        const tok = this.tokens[this.i];
        this.i += 1;
        return tok;
    }

    parse() {
        const left = this.operand();
        const tok = this.peek();
        if (!tok || !(tok.kind === 'op' || (tok.kind === 'kw' && tok.value === 'in'))) {
            throw new ConditionError(MISSING_OP);
        }
        this.take();
        const right = this.operand();
        const rest = this.peek();
        if (rest) throw new ConditionError(`多余的记号：${this.src.slice(rest.pos).trim()}`);
        return [left, tok.value, right];
    }

    operand() {
        const tok = this.peek();
        if (!tok) throw new ConditionError(MISSING_OP);
        if (tok.kind === 'num') {
            this.take();
            return ['num', tok.value];
        }
        if (tok.kind === 'str') {
            this.take();
            return ['str', tok.value];
        }
        if (tok.kind === 'var') {
            this.take();
            return ['var', tok.value];
        }
        if (tok.kind === 'kw') {
            this.take();
            if (tok.value === 'true' || tok.value === 'false') return ['bool', tok.value === 'true'];
            if (tok.value === 'null') return ['null'];
            throw new ConditionError(`无法识别的记号：位置 ${tok.pos}`);
        }
        if (tok.kind === '[') {
            this.take();
            const items = [];
            const first = this.peek();
            if (first && first.kind === ']') {
                this.take();
                return ['list', items];
            }
            for (;;) {
                items.push(this.operand());
                if (items.length > MAX_ARRAY_ITEMS) {
                    throw new ConditionError(`数组元素过多（最多 ${MAX_ARRAY_ITEMS}）`);
                }
                const nxt = this.peek();
                if (!nxt) throw new ConditionError(`多余的记号：${this.src.trim()}`);
                if (nxt.kind === ',') {
                    this.take();
                    continue;
                }
                if (nxt.kind === ']') {
                    this.take();
                    return ['list', items];
                }
                throw new ConditionError(`多余的记号：${this.src.slice(nxt.pos).trim()}`);
            }
        }
        throw new ConditionError(`无法识别的记号：位置 ${tok.pos}`);
    }
}

/**
 * 解析成 `[左, 运算符, 右]` —— **只查语法**，不看变量（保存前校验用它）。
 * @throws {ConditionError}
 */
export function parseCondition(src) {
    if (src === null || src === undefined) throw new ConditionError('条件为空');
    const text = String(src).trim();
    if (!text) throw new ConditionError('条件为空');
    const charCount = Array.from(text).length;
    if (charCount > MAX_CONDITION_LEN) {
        throw new ConditionError(`条件超长（${charCount} > ${MAX_CONDITION_LEN} 字符）`);
    }
    const tokens = lex(text);
    if (!tokens.length) throw new ConditionError('条件为空');
    if (tokens.length > MAX_TOKENS) {
        throw new ConditionError(`条件过于复杂（${tokens.length} > ${MAX_TOKENS} 个记号）`);
    }
    return new Parser(tokens, text).parse();
}

function valueOf(node, variables) {
    const [kind, payload] = node;
    if (kind === 'num' || kind === 'str' || kind === 'bool') return payload;
    if (kind === 'null') return null;
    if (kind === 'list') return payload.map((item) => valueOf(item, variables));
    // var：整串精确查表（不做点号下钻，见模块注释）
    const name = payload;
    if (!Object.prototype.hasOwnProperty.call(variables, name)) {
        throw new ConditionError(`变量未定义：${name}`);
    }
    return variables[name];
}

function equal(a, b) {
    if (a === null || b === null) return a === null && b === null;
    if (typeof a === 'boolean' || typeof b === 'boolean') {
        if (typeof a === 'boolean' && typeof b === 'boolean') return a === b;
        throw new ConditionError(`类型无法比较：${kindOf(a)} 与 ${kindOf(b)}`);
    }
    if (typeof a === 'number' && typeof b === 'number') return a === b;
    if (typeof a === 'string' && typeof b === 'string') return a === b;
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((x, k) => equal(x, b[k]));
    }
    throw new ConditionError(`类型无法比较：${kindOf(a)} 与 ${kindOf(b)}`);
}

function order(op, a, b) {
    if (typeof a === 'boolean' || typeof b === 'boolean') {
        throw new ConditionError(`类型无法比较：${kindOf(a)} 与 ${kindOf(b)}`);
    }
    let left;
    let right;
    if (typeof a === 'number' && typeof b === 'number') {
        left = a;
        right = b;
    } else if (typeof a === 'string' && typeof b === 'string') {
        // 字符串顺序比较按各自运行时字典序（BMP 内一致）；推荐只用于 ==/!=/in
        left = a;
        right = b;
    } else {
        throw new ConditionError(`类型无法比较：${kindOf(a)} 与 ${kindOf(b)}`);
    }
    if (op === '>') return left > right;
    if (op === '<') return left < right;
    if (op === '>=') return left >= right;
    return left <= right;
}

/**
 * 解析 + 求值 → boolean；任何非法都抛 `ConditionError`（**绝不静默当 false**）。
 * @param {string} src
 * @param {Record<string, unknown>} variables 扁平字符串键的变量表（BE 运行期供给）
 * @throws {ConditionError}
 */
export function evaluateCondition(src, variables) {
    const [left, op, right] = parseCondition(src);
    const a = valueOf(left, variables || {});
    const b = valueOf(right, variables || {});
    if (op === 'in') {
        if (Array.isArray(b)) return b.some((item) => equal(a, item));
        if (typeof a === 'string' && typeof b === 'string') return b.includes(a); // 双端同口径：a 是 b 的子串
        throw new ConditionError(`右侧须是数组或字符串，实得 ${kindOf(b)}`);
    }
    if (op === '==' || op === '!=') {
        const hit = equal(a, b);
        return op === '==' ? hit : !hit;
    }
    return order(op, a, b);
}

/**
 * 只查语法（不查变量）→ `null` = 合法，否则返回错误文案（UI 就地红字用）。
 * @param {string} src
 * @returns {string|null}
 */
export function checkCondition(src) {
    try {
        parseCondition(src);
        return null;
    } catch (e) {
        return e instanceof ConditionError ? e.message : String(e);
    }
}

"""R26（PLAN §8.58）序列步骤条件 —— 受限表达式求值（**无 eval / 无 exec / 无属性反射**）。

一条条件 = **一次比较**：`左操作数 运算符 右操作数`。

- 运算符恰 6 个：`==` `!=` `>=` `<=` `>` `<` 与关键字 `in`（§8.52 拍板原列 5 项
  `== != > < in`，**补上 `>=` / `<=`** —— §8.36 例 A 的原型就是 `fw_version >= 0x1200`，
  同族比较、不新增能力面）。
- 操作数四种：数字字面量（十进制 / `0x` 十六进制 / `0b` 二进制 / 小数）、字符串字面量
  （单双引号，反斜杠 = 原样取下一字符）、关键字 `true` / `false` / `null`（大小写不敏感）、
  **变量名**与**数组字面量** `[a, b]`（`in` 的右操作数用）。
- **没有算术、没有括号、没有函数调用、没有布尔连接** —— 解析器只认上面这些记号，
  多一个字符就报错（fail-closed：保存侧 400、运行侧记步 `COND:` 错误）。
- 变量名是**一整个裸词**（可含 `.`、`-`、中文，不含空白与引号）：运行期由
  `sequence_runner` 供一张**扁平字符串键**的变量表，查表 = **整串精确匹配**，
  不做点号下钻、不做属性反射 → 变量表里放什么就是什么。

限制（防御纵深，双端同值）：条件 ≤ `MAX_CONDITION_LEN` 字符、≤ `MAX_TOKENS` 个记号、
数组 ≤ `MAX_ARRAY_ITEMS` 元素。

双端纪律：FE `utils/condition.js` 与本文件**逐行同语义**，共享向量
`vectors/condition.json` 逐行断言（含错误文案逐字相同），改一必改二。
"""

import re
from typing import Any, Dict, List, NamedTuple, Optional, Sequence, Tuple

#: 条件串长度上限（字符）
MAX_CONDITION_LEN = 200
#: 记号数上限（防御解析爆炸；一次比较最多十几个记号，64 已极宽松）
MAX_TOKENS = 64
#: 数组字面量元素上限
MAX_ARRAY_ITEMS = 32

#: 拍板运算符集（`in` 走关键字，大小写不敏感）
OPS: Tuple[str, ...] = ("==", "!=", ">=", "<=", ">", "<")
#: 关键字（大小写不敏感）
KEYWORDS: Tuple[str, ...] = ("true", "false", "null", "in")

#: 缺运算符时的固定文案（FE 同字面量）
_MISSING_OP = "缺少比较运算符（支持 == != >= <= > < in）"

#: 数字字面量（`0x` / `0b` / 十进制整数 / 小数 / 科学计数）
_NUMBER_RE = re.compile(
    r"-?(?:0[xX][0-9a-fA-F]+|0[bB][01]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)"
)


class ConditionError(ValueError):
    """条件本身非法：语法 / 超限 / 变量未定义 / 类型不可比。

    保存侧（`routers/sequence._normalize_steps`）捕获 → 400 定位到 `steps[i]`；
    运行侧（`sequence_runner.execute`）捕获 → 记步 `COND: {原因}`（与 `PLAN:` /
    `WRAP:` / `TRANSPORT:` 四分，语义同：失败在这一层、字节未发出）。
    """


class Token(NamedTuple):
    kind: str  # num | str | var | kw | op | [ | ] | ,
    value: Any
    pos: int


def _kind(value: Any) -> str:
    """变量值 → 类型名（**错误文案跨端逐字相同**，故只用这 5 种固定名）。"""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "布尔"
    if isinstance(value, (int, float)):
        return "数字"
    if isinstance(value, str):
        return "字符串"
    if isinstance(value, (list, tuple)):
        return "数组"
    return "未知"


def _number_of(text: str) -> Any:
    """字面量文本 → 数值（`0x` / `0b` / 十进制整数 / 小数）。"""
    negative = text.startswith("-")
    body = text[1:] if negative else text
    low = body.lower()
    if low.startswith("0x"):
        value: Any = int(body[2:], 16)
    elif low.startswith("0b"):
        value = int(body[2:], 2)
    elif "." in body or "e" in low:
        value = float(body)
    else:
        value = int(body, 10)
    return -value if negative else value


def _lex(src: str) -> List[Token]:
    """词法：空白忽略；运算符先于裸词；裸词吃到分隔符为止。

    裸词分隔符 = 空白与 `[] ,` 及引号 —— 故 `fw_version`、`step.1.received`、
    `固件版本`、`a-b` 都是**一个**变量名（不做点号下钻，见模块 docstring）。
    """
    out: List[Token] = []
    i, n = 0, len(src)
    delims = " \t\r\n()[],\"'"
    while i < n:
        ch = src[i]
        if ch in " \t\r\n":
            i += 1
            continue
        two = src[i : i + 2]
        if two in ("==", "!=", ">=", "<="):
            out.append(Token("op", two, i))
            i += 2
            continue
        if ch in "><":
            out.append(Token("op", ch, i))
            i += 1
            continue
        if ch in "[]":
            out.append(Token(ch, ch, i))
            i += 1
            continue
        if ch in "()":
            # 拍板不含括号（无布尔连接）→ 不给「分组」留口子，直接判非法
            raise ConditionError(f"无法识别的记号：位置 {i}")
        if ch == ",":
            out.append(Token(",", ch, i))
            i += 1
            continue
        if ch in "\"'":
            j = i + 1
            buf: List[str] = []
            while j < n and src[j] != ch:
                if src[j] == "\\" and j + 1 < n:
                    buf.append(src[j + 1])  # 反斜杠 = 原样取下一字符（双端同口径）
                    j += 2
                    continue
                buf.append(src[j])
                j += 1
            if j >= n:
                raise ConditionError(f"字符串未闭合：位置 {i}")
            out.append(Token("str", "".join(buf), i))
            i = j + 1
            continue
        if ch in "0123456789" or (ch == "-" and i + 1 < n and src[i + 1] in "0123456789"):
            m = _NUMBER_RE.match(src, i)
            if m is None:
                raise ConditionError(f"无法识别的记号：位置 {i}")
            out.append(Token("num", _number_of(m.group(0)), i))
            i = m.end()
            continue
        # 裸词（变量名 / 关键字）
        j = i
        while j < n and src[j] not in delims:
            j += 1
        word = src[i:j]
        if not word:  # 防御：分隔符必被上面的分支吃掉，走到这里即词法破损
            raise ConditionError(f"无法识别的记号：位置 {i}")
        low = word.lower()
        if low in KEYWORDS:
            out.append(Token("kw", low, i))
        else:
            out.append(Token("var", word, i))
        i = j
    return out


class _Parser:
    def __init__(self, tokens: Sequence[Token], src: str):
        self.tokens = list(tokens)
        self.src = src
        self.i = 0

    def peek(self) -> Optional[Token]:
        return self.tokens[self.i] if self.i < len(self.tokens) else None

    def take(self) -> Token:
        tok = self.tokens[self.i]
        self.i += 1
        return tok

    def parse(self) -> Tuple[Any, str, Any]:
        left = self.operand()
        tok = self.peek()
        if tok is None or not (
            tok.kind == "op" or (tok.kind == "kw" and tok.value == "in")
        ):
            raise ConditionError(_MISSING_OP)
        self.take()
        right = self.operand()
        rest = self.peek()
        if rest is not None:
            raise ConditionError(f"多余的记号：{self.src[rest.pos :].strip()}")
        return left, tok.value, right

    def operand(self) -> Any:
        tok = self.peek()
        if tok is None:
            raise ConditionError(_MISSING_OP)
        if tok.kind == "num":
            self.take()
            return ("num", tok.value)
        if tok.kind == "str":
            self.take()
            return ("str", tok.value)
        if tok.kind == "var":
            self.take()
            return ("var", tok.value)
        if tok.kind == "kw":
            self.take()
            if tok.value in ("true", "false"):
                return ("bool", tok.value == "true")
            if tok.value == "null":
                return ("null",)
            raise ConditionError(f"无法识别的记号：位置 {tok.pos}")
        if tok.kind == "[":
            self.take()
            items: List[Any] = []
            nxt = self.peek()
            if nxt is not None and nxt.kind == "]":
                self.take()
                return ("list", items)
            while True:
                items.append(self.operand())
                if len(items) > MAX_ARRAY_ITEMS:
                    raise ConditionError(f"数组元素过多（最多 {MAX_ARRAY_ITEMS}）")
                nxt = self.peek()
                if nxt is None:
                    raise ConditionError(f"多余的记号：{self.src.strip()}")
                if nxt.kind == ",":
                    self.take()
                    continue
                if nxt.kind == "]":
                    self.take()
                    return ("list", items)
                raise ConditionError(f"多余的记号：{self.src[nxt.pos :].strip()}")
        raise ConditionError(f"无法识别的记号：位置 {tok.pos}")


def parse_condition(src: Any) -> Tuple[Any, str, Any]:
    """解析成 `(左, 运算符, 右)` 三元组 —— **只查语法**，不看变量（保存侧用它）。"""
    if src is None:
        raise ConditionError("条件为空")
    text = str(src).strip()
    if not text:
        raise ConditionError("条件为空")
    if len(text) > MAX_CONDITION_LEN:
        raise ConditionError(f"条件超长（{len(text)} > {MAX_CONDITION_LEN} 字符）")
    tokens = _lex(text)
    if not tokens:
        raise ConditionError("条件为空")
    if len(tokens) > MAX_TOKENS:
        raise ConditionError(f"条件过于复杂（{len(tokens)} > {MAX_TOKENS} 个记号）")
    return _Parser(tokens, text).parse()


def _value(node: Any, variables: Dict[str, Any]) -> Any:
    kind = node[0]
    if kind in ("num", "str", "bool"):
        return node[1]
    if kind == "null":
        return None
    if kind == "list":
        return [_value(item, variables) for item in node[1]]
    # var：整串精确查表（不做点号下钻，见模块 docstring）
    name = node[1]
    if name not in variables:
        raise ConditionError(f"变量未定义：{name}")
    return variables[name]


def _equal(a: Any, b: Any) -> bool:
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, bool) or isinstance(b, bool):
        if isinstance(a, bool) and isinstance(b, bool):
            return a is b
        raise ConditionError(f"类型无法比较：{_kind(a)} 与 {_kind(b)}")
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return float(a) == float(b)
    if isinstance(a, str) and isinstance(b, str):
        return a == b
    if isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):
        return len(a) == len(b) and all(_equal(x, y) for x, y in zip(a, b))
    raise ConditionError(f"类型无法比较：{_kind(a)} 与 {_kind(b)}")


def _order(op: str, a: Any, b: Any) -> bool:
    if isinstance(a, bool) or isinstance(b, bool):
        raise ConditionError(f"类型无法比较：{_kind(a)} 与 {_kind(b)}")
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        left: Any = float(a)
        right: Any = float(b)
    elif isinstance(a, str) and isinstance(b, str):
        # 字符串顺序比较按各自运行时字典序（BMP 内一致）；推荐只用于 ==/!=/in
        left, right = a, b
    else:
        raise ConditionError(f"类型无法比较：{_kind(a)} 与 {_kind(b)}")
    if op == ">":
        return left > right
    if op == "<":
        return left < right
    if op == ">=":
        return left >= right
    return left <= right


def evaluate_condition(src: Any, variables: Dict[str, Any]) -> bool:
    """解析 + 求值 → bool；任何非法都抛 `ConditionError`（**绝不静默当 False**）。

    `variables` 是**扁平字符串键**的变量表（运行期由 `sequence_runner` 供给
    `step.<n>.*` 与最近一次出现的字段名；求值只做精确查表）。
    """
    left, op, right = parse_condition(src)
    a = _value(left, variables)
    b = _value(right, variables)
    if op == "in":
        if isinstance(b, (list, tuple)):
            return any(_equal(a, item) for item in b)
        if isinstance(a, str) and isinstance(b, str):
            return a in b
        raise ConditionError(f"右侧须是数组或字符串，实得 {_kind(b)}")
    if op in ("==", "!="):
        hit = _equal(a, b)
        return hit if op == "==" else not hit
    return _order(op, a, b)

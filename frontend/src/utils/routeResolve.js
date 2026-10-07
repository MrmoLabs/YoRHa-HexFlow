// R39（PLAN §8.71）：发前路由接线的纯逻辑层 —— 加工页「按输入自动选指令」；
// R40（PLAN §8.72）第二个消费方 = 规则页「试解析」—— 同一份回执换一种动作语境
// （见文件尾 describeDryRun），输入表与类型口径原样复用，不另起一套。
//
// 三条口径（与后端 resolve_route 逐字对齐，FE 只呈现不改判）：
//  ① **输入表是扁平键值**（与 evaluate_condition 的变量表同形）：键去两端空白、
//     空键行整行不发 —— 手抖多敲一个空格，不该让整条规则静默不命中；值**按 JSON
//     标量解析**（见 parseInputValue）—— 后端数字/字符串类型不同即不中，FE 只送
//     字符串会让数字条件与全部数值比较符静默失效；
//  ② **回执怎么说就怎么显示**：matched 由后端给，无命中 = 不猜、维持现状，FE 不许
//     自己挑一条「看起来差不多」的指令顶上；结构性缺陷有几条写几条；
//  ③ **命中才切、切前留痕**：目标指令回执里没带回就不切、文案也不谎称切了；
//     切之前记下上一条，供「回到上一条」一键回退。
//
// 本仓未装 @testing-library/jest-dom → 组件里不依赖 matchers 扩展。
export const emptyRouteInput = () => ({ key: '', value: '' });

export const emptyRouteInputs = () => [emptyRouteInput()];

export const addRouteInput = (rows) => [...rows, emptyRouteInput()];

export const removeRouteInput = (rows, index) => rows.filter((_, i) => i !== index);

export const patchRouteInput = (rows, index, patch) => rows.map((row, i) => (
    i === index ? { ...row, ...patch } : row
));

// 行表 → 后端 inputs：**值按 JSON 标量解析**（`0001` → 数字 1，`"0001"` → 字符串
// 0001，其余按字符串原文发）。这条不是 FE 自作聪明：后端 `_equal` 数字/字符串
// **类型不同就抛错（= 不命中）**，而条件里的 `0001` 是数字字面量、`>` `<` `>=`
// `<=` 也只在两端同为数字时才有意义 —— FE 的输入框只有文本，不解析类型，数字条件
// 与全部数值比较符都会静默永不命中（R39 实机冒烟抓到）。键去两端空白、空键行不发；
// 键重复时后写的赢（面板按行编辑，后一行才是用户最后确认的值）。
export const parseInputValue = (raw) => {
    const text = String(raw ?? '').trim();
    if (!text) return '';
    // 纯数字（含 0001 / 1.5 / 1e3）按数字发
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text)) return Number(text);
    // 显式加引号 = 按字符串（「0001」这种前导零串唯一出口）
    if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
        try {
            const inner = JSON.parse(text);
            if (typeof inner === 'string') return inner;
        } catch { /* 引号内不是合法 JSON → 退回去引号原文 */ }
        return text.slice(1, -1);
    }
    return text;
};

// 输入行右侧的类型徽标：让用户当场看见「这行会按什么类型发出去」。
export const describeInputType = (raw) => {
    const value = parseInputValue(raw);
    if (value === '') return '空';
    return typeof value === 'number' ? '数字' : '字符串';
};

export const toInputsMap = (rows) => (rows || []).reduce((acc, row) => {
    const key = String(row?.key ?? '').trim();
    if (!key) return acc;
    acc[key] = parseInputValue(row?.value);
    return acc;
}, {});

export const filledInputCount = (rows) => (rows || []).filter(
    (row) => String(row?.key ?? '').trim() !== ''
).length;

// 切不切只看回执给没给 id —— 两处都缺就是「没给」，不硬凑。
export const resolveInstructionId = (res) => {
    if (res?.instruction_id) return res.instruction_id;
    if (res?.instruction?.id) return res.instruction.id;
    return null;
};

// 目标指令不在册 → 补进列表尾部（R36 给全量指令全文正是为此，省一次 /instructions）。
// 已在册 / 没带全文时**返回原引用**，不制造无意义的重渲染。
export const mergeResolvedInstruction = (instructions, res) => {
    const list = instructions || [];
    const incoming = res?.instruction;
    if (!incoming || !incoming.id) return list;
    if (list.some((item) => item.id === incoming.id)) return list;
    return [...list, incoming];
};

const invalidNote = (res) => {
    const count = Array.isArray(res?.invalid) ? res.invalid.length : 0;
    if (!count) return '';
    return `另有 ${count} 条结构性缺陷已跳过（条件语法坏掉 / 目标指令不在册）。`;
};

// ── R43（PLAN §8.75）轨迹码 → 中文事实 ─────────────────────────────────────
// 后端 `core/routing.TRACE_CODES` 同表，改一必改二。**判定与事实都在后端**
// （code 是机器码、detail 是后端给的载荷），这里只做呈现：不认识的码原样透出，
// 不猜 —— 谎编一句原因比显示英文码更糟。
const TRACE_LABELS = {
    MATCHED: '判真命中',
    COND_FALSE: '比较不成立',
    VAR_UNDEFINED: '变量不在本次输入里',
    TYPE_INCOMPARABLE: '类型不可比',
    COND_ERROR: '求值未通过',
    CONDITION_INVALID: '条件语法不成立',
    INSTRUCTION_MISSING: '目标指令不在册',
    DISABLED: '已停用（不参与匹配）',
    NOT_EVALUATED: '未轮到 —— 前面已有命中，按 first-match-wins 不再看',
};

// 既服务 `invalid.reason`（它可能是个码，也可能是后端给的中文原文），也服务
// 轨迹行 —— 同一条规则在「缺陷跳过」与轨迹里出现两次，措辞必须同源。
export const traceReasonText = (code, detail = '') => {
    const raw = String(code ?? '').trim();
    const label = Object.prototype.hasOwnProperty.call(TRACE_LABELS, raw)
        ? TRACE_LABELS[raw]
        : raw;
    if (!label) return '（回执未给原因）';
    const tail = String(detail ?? '').trim();
    return tail ? `${label}：${tail}` : label;
};

// 回执 → { matched, text }。matched 是**后端给的**，这里原样带出去供上层选样式；
// text 只陈述已发生的事实（扫了几条、切没切、维持的是谁），不断言用户意图。
export const describeResolve = (res, { previousName = null } = {}) => {
    const note = invalidNote(res);

    if (res?.matched) {
        const ruleName = res.rule?.name || '（规则未回带名称）';
        const targetId = resolveInstructionId(res);
        if (!targetId) {
            return {
                matched: true,
                text: `命中规则「${ruleName}」→ 但回执未带回目标指令，未切换。${note}`,
            };
        }
        const instName = res.instruction?.name || res.instruction?.code || targetId;
        return {
            matched: true,
            text: `命中规则「${ruleName}」→ 已切到指令「${instName}」。${note}`,
        };
    }

    const considered = Number(res?.considered) || 0;
    const why = considered === 0
        ? '没有任何规则参与（无规则或全部停用）'
        : `扫过 ${considered} 条规则都不成立`;
    const kept = previousName
        ? `当前指令「${previousName}」`
        : '当前未选中状态';
    return { matched: false, text: `无命中 —— ${why}，维持${kept}不猜。${note}` };
};

export const describeResolveError = (err) => (
    `解析失败 —— ${err?.message || '无法连接后端服务'}`
);

// ── R40（PLAN §8.72）试解析：同一份回执的**另一种动作语境** ─────────────────
// 加工页真的会切指令（describeResolve 写「已切到指令…」）；规则页试解析**只回显**，
// 一行状态都不改 —— 所以这里断在「命中 / 无命中」，绝不把「已切到」搬过来。
// 结果表四行恒在，值 = 回执原样转写：`considered` / `invalid` 由后端给，FE 不自己数、
// 更不自己扫第二遍条件（不造第二套判据）。
const describeInvalid = (list) => {
    if (!list.length) return '0 条';
    const items = list.map((item) => {
        const name = String(item?.name ?? '').trim() || '（未命名）';
        const reason = traceReasonText(item?.reason);
        return `规则「${name}」：${reason}`;
    });
    return `${list.length} 条 —— ${items.join('；')}`;
};

// R43（§8.75）逐条判定轨迹：一行 = 回执一条规则。序号 = 回执行序（= 定序），
// 名 / 条件 / 码 / 文案全部原样转写 —— **FE 不扫第二遍条件**。
const describeTrace = (list) => {
    if (!Array.isArray(list)) return [];
    return list.map((entry, index) => ({
        index: index + 1,
        name: String(entry?.name ?? '').trim() || '（未命名）',
        condition: String(entry?.condition ?? '').trim() || '（无条件）',
        code: String(entry?.code ?? '').trim(),
        text: traceReasonText(entry?.code, entry?.detail),
    }));
};

export const describeDryRun = (res) => {
    const invalid = Array.isArray(res?.invalid) ? res.invalid : [];
    const considered = Number(res?.considered) || 0;
    const matched = Boolean(res?.matched);

    // 未命中时两行都写「（无命中）」—— 后端此时 rule/instruction 本就是 null，
    // 不硬造一个「看起来最像」的规则名顶上。
    const ruleName = matched ? (res?.rule?.name || '（规则未回带名称）') : '（无命中）';
    const targetId = matched ? resolveInstructionId(res) : null;
    const targetName = matched
        ? (res?.instruction?.name || res?.instruction?.code || targetId || '（回执未带回目标指令）')
        : '（无命中）';

    const headline = matched
        ? (targetId
            ? `命中 —— 规则「${ruleName}」→ 指令「${targetName}」（只解析，不发送）。`
            : `命中 —— 规则「${ruleName}」，但回执未带回目标指令。`)
        : (considered === 0
            ? '无命中 —— 没有任何规则参与（无规则或全部停用）。'
            : `无命中 —— 扫过 ${considered} 条规则都不成立。`);

    return {
        matched,
        headline,
        rows: [
            { label: '命中规则', value: ruleName },
            { label: '目标指令', value: targetName },
            {
                label: '参与扫描',
                value: considered === 0 ? '0 条 —— 无规则或全部停用' : `${considered} 条`,
            },
            { label: '缺陷跳过', value: describeInvalid(invalid) },
        ],
        // R43：逐条判定轨迹（回执给的是机器码，中文在这里出）
        trace: describeTrace(res?.trace),
    };
};


/**
 * Global Constants for YoRHa-HexFlow Application
 */

export const OP_CODES = {
    HEX_RAW: 'HEX_RAW',
    INT_UNSIGNED: 'INT_UNSIGNED',
    INT_SIGNED: 'INT_SIGNED',
    FLOAT_IEEE: 'FLOAT_IEEE',
    SCALED_DECIMAL: 'SCALED_DECIMAL',
    BCD_CODE: 'BCD_CODE',
    BITFIELD: 'BITFIELD',
    MAPPING: 'MAPPING',
    ARRAY_GROUP: 'ARRAY_GROUP',
    // 结构组 op（属性面板/校验以字面 'STRUCT' 使用）。OP_CODES 此前缺此键 →
    // `undefined === OP_CODES.STRUCT` 对无 op_code 的协议块恒真，全部协议块被
    // 误判成组卡、hex 分支永不命中——人工验证反馈 #1「固定块不显示实际取值」根因。
    STRUCT: 'STRUCT',
    LENGTH_CALC: 'LENGTH_CALC',
    CHECKSUM_CRC: 'CHECKSUM_CRC',
    TIME_ACCUMULATOR: 'TIME_ACCUMULATOR',
    AUTO_COUNTER: 'AUTO_COUNTER',
    // R23 (§8.52 排期 · 挂账 ①): 绝对时间戳 —— 替代「手填 INT_UNSIGNED 语义化
    // epoch」。无 base_time（只有当前墙钟），unit=s|ms，发送时按墙钟重算。
    // KNOWN_OPS 经 Object.values(OP_CODES) 自动收录（N1 护栏跟随，BE
    // routers/instruction.py 的 KNOWN_OPS 同批 20 → 21，改一必改二）。
    TIME_EPOCH: 'TIME_EPOCH',
    // N2 (G2): 定长文本字段（ascii/utf8 × pad/截断）——G2「字符串三连」的正经
    // 入口。KNOWN_OPS 经 Object.values(OP_CODES) 自动收录（N1 护栏跟随）。
    STRING: 'STRING',
    // R25 (§8.52 排期 · 挂账 ②): 加扰 / 混淆字段 —— 明文（pc.hex，与 HEX_RAW 同源）
    // 出线前按 mode 变换（XOR_SEED 异或种子 / BIT_ROLL 逐字节左旋）。口径档案在
    // utils/scramble.js，BE core/orchestrator.encode_scramble 逐行同语义。KNOWN_OPS
    // 经 Object.values(OP_CODES) 自动收录（N1 护栏跟随，BE routers/instruction.py 的
    // KNOWN_OPS 同批 21 → 22，改一必改二）。
    SCRAMBLE: 'SCRAMBLE'
};

export const CATEGORIES = {
    BASE: 'BASE',
    NUMERIC: 'NUMERIC',
    ENCODING: 'ENCODING',
    DYNAMIC: 'DYNAMIC',
    LOGIC: 'LOGIC',
    STRUCT: 'STRUCT'
};

export const OP_PRIORITY = [
    OP_CODES.HEX_RAW,
    OP_CODES.STRING,
    OP_CODES.INT_UNSIGNED,
    OP_CODES.INT_SIGNED,
    OP_CODES.FLOAT_IEEE,
    OP_CODES.SCALED_DECIMAL,
    OP_CODES.BCD_CODE,
    OP_CODES.SCRAMBLE,
    OP_CODES.BITFIELD,
    OP_CODES.TIME_ACCUMULATOR,
    OP_CODES.AUTO_COUNTER,
    OP_CODES.TIME_EPOCH,
    OP_CODES.MAPPING,
    OP_CODES.ARRAY_GROUP,
    OP_CODES.LENGTH_CALC,
    OP_CODES.CHECKSUM_CRC
];

export const CATEGORY_ORDER = [
    CATEGORIES.BASE,
    CATEGORIES.NUMERIC,
    CATEGORIES.ENCODING,
    CATEGORIES.DYNAMIC,
    CATEGORIES.LOGIC,
    CATEGORIES.STRUCT
];

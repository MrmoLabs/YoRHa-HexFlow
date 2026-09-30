import { evaluateFormula, formatToHex, formatFloatToHex, calculateChecksum, ChecksumAlgo } from './formula';

/**
 * Core Logic for the Instruction Processing Engine.
 * Decouples "Byte Generation" from "UI Rendering".
 */
export const InstructionEncoder = {
    /**
     * Helper to flatten nested fields/blocks for linear encoding.
     * MODIFIED: Now optionally keeps parent containers for reference, 
     * but we usually want a list of *everything* to build the symbol table.
     */
    flattenAll: function (items) {
        let flat = [];
        if (!items) return flat;
        const sortedItems = [...items].sort((a, b) => (a.sequence ?? a.order ?? 0) - (b.sequence ?? b.order ?? 0));

        sortedItems.forEach(item => {
            flat.push(item);
            if (item.fields || item.blocks || item.children) {
                flat = flat.concat(this.flattenAll(item.fields || item.blocks || item.children));
            }
        });
        return flat;
    },

    /**
     * Generates the initial user input state based on default values.
     */
    getInitialValues: function (instruction) {
        const initialInputs = {};
        if (!instruction) return initialInputs;

        const rawFields = instruction.fields || instruction.blocks || [];
        const allFields = this.flattenAll(rawFields);

        allFields.forEach(field => {
            const params = field.parameter_config || {};
            const op = String(field.op_code || '').toUpperCase();
            const type = String(params.type || '').toLowerCase();
            const isInput = op === 'INPUT' || params.variable || op === 'STRING';

            if (isInput) {
                if (op === 'STRING') {
                    // N2 (G2): 文本字段初始录入值 = 静态 value（与编码兜底同源）——
                    // 加工页回显与实发字节一致，可继续键入修改；无值 → 空串。
                    initialInputs[field.id] = params.value ?? params.default ?? '';
                } else if (params.default !== undefined) {
                    initialInputs[field.id] = params.default;
                } else if (params.options) {
                    // Enum Default: First option's value
                    const opts = params.options;
                    if (Array.isArray(opts) && opts.length > 0) {
                        const first = opts[0];
                        let val = typeof first === 'object' ? first.value : first;
                        // HEX String to Number auto-conversion for consistency
                        if (typeof val === 'string' && /^[0-9A-Fa-f]+$/.test(val)) {
                            val = parseInt(val, 16);
                        }
                        initialInputs[field.id] = val;
                    } else if (typeof opts === 'object' && Object.keys(opts).length > 0) {
                        let val = Object.values(opts)[0];
                        if (typeof val === 'string' && /^[0-9A-Fa-f]+$/.test(val)) {
                            val = parseInt(val, 16);
                        }
                        initialInputs[field.id] = val;
                    } else {
                        initialInputs[field.id] = 0;
                    }
                } else if (type === 'string' || type === 'text') {
                    initialInputs[field.id] = '';
                } else {
                    initialInputs[field.id] = 0;
                }
            }
        });
        return initialInputs;
    },

    /**
     * Public byte accessor (E1-2 / B6): encodes big-endian first, then
     * reverses the whole byte sequence when endianness=LITTLE. Groups
     * (containers) are never reversed as a whole — children recurse
     * through this wrapper individually.
     */
    // `now`（epoch ms，E1-6）贯穿到叶子：TIME_ACCUMULATOR 的墙钟 Current，
    // encodeInstruction 注入（opts.now），缺省 Date.now()；组递归逐层透传。
    getFieldBytes: function (field, inputs, computedValues, allFields, now) {
        const bytes = this._encodeFieldBytes(field, inputs, computedValues, allFields, now);
        // R1: children 树组（协议容器/合并树）与 fields 组同权 —— 容器整体不做
        // LITTLE 逆序（子叶在递归中各自按 endianness 处理，E1-2 语义不变）。
        const isGroup = (field.fields && field.fields.length > 0)
            || (field.children && field.children.length > 0);
        if (!isGroup
            && bytes.length > 1
            && String(field.endianness || '').toUpperCase() === 'LITTLE') {
            return [...bytes].reverse();
        }
        return bytes;
    },

    /**
     * Helper to get byte data for a specific field based on current value and params.
     * Supports RECURSIVE generation for Groups.
     * NOTE: emits op-semantic (big-endian) byte order — LITTLE reversal lives
     * in the getFieldBytes wrapper. Checksum/refs consumers call this
     * directly so referenced value bytes stay unreversed (matches backend).
     * `now`（epoch ms）仅 TIME_ACCUMULATOR 消费，其余路径忽略。
     */
    _encodeFieldBytes: function (field, inputs, computedValues, allFields, now) {
        // N3 (G1): presence 未命中 → 0 字节（组整棵子树；叶被 checksum refs
        // 引用时以 0 字节进校验）。
        if (!this._presenceHit(field, inputs, computedValues, allFields)) return [];
        const params = field.parameter_config || {};
        // R1: byte_len（指令扁平字段）|| byte_length（协议节点/合并块），皆缺或
        // 0 → 1 —— E1-3 既有 `byte_len || 1` 归一保持（指令字段无 byte_length
        // 键，链尾回退不改其口径）；协议卡宽度自此锚 byte_length。
        const byteLen = field.byte_len || field.byte_length || 1;
        const op = field.op_code;

        // 0. Groups / Arrays (Recursive)
        // If it has children, its bytes are the sum of its children
        // R1: children 树组（协议容器 / 合并树）与 fields 组同权 —— 后端语义锚
        // datahub.to_block:138 有 kids → container、_flatten_recursive:101 容器
        // 自身字节不入流。
        const groupChildren = (field.fields && field.fields.length > 0) ? field.fields
            : (field.children && field.children.length > 0) ? field.children : null;
        if (groupChildren) {
            let groupBytes = [];
            // Sort children
            const children = [...groupChildren].sort((a, b) => (a.sequence ?? a.order ?? 0) - (b.sequence ?? b.order ?? 0));
            children.forEach(child => {
                const childBytes = this.getFieldBytes(child, inputs, computedValues, allFields, now);
                groupBytes = groupBytes.concat(childBytes);
            });
            // E1-5 (B7): repeat 展开 —— 子块序列整体重复 N 次（每份取同一 inputs，
            // 子字段值不逐份变化）。N 见 _repeatCount，与后端 to_block resolve +
            // orchestrator._flatten_recursive byte-equal（向量表锚定双端测试）。
            const repeats = this._repeatCount(field, inputs, computedValues, allFields);
            if (repeats === 0) return [];
            let out = groupBytes;
            for (let i = 1; i < repeats; i++) out = out.concat(groupBytes);
            return out;
        }

        // R1: 协议树特殊叶 —— slot 占位不发射（orchestrator.py:76 跳过 SLOT 同
        // 口径）；容器（children:[] 空容器落此）只发子字节 → 0 字节，不产脏 00。
        if (field.type === 'slot' || field.type === 'container') return [];

        // LEAF NODES logic
        const inputValue = inputs[field.id];
        const computedVal = computedValues[field.id];
        // Priority: Computed > Input > Fixed
        // EXCEPT for HEX_RAW where 'hex' param might be the "value" even if input is undefined

        let value = 0;
        if (computedVal !== undefined) value = computedVal;
        else if (inputValue !== undefined) value = inputValue;
        else if (params.hex && (op === 'FIXED' || op === 'HEADER' || op === 'TAIL')) return this.parseHexBytes(params.hex);
        else if (op === 'HEX_RAW' && params.hex) return this.parseHexBytes(params.hex); // Raw Hex string
        // R1: 协议 fixed 直读 hex_value（无 op_code / parameter_config.hex 的协议叶，
        // 对齐 datahub.to_block 固定帧 hex_value 出流）；协议 length/checksum 卡的
        // hex_value='00' 被上文 computedVal（PASS1/PASS2 注入）压制，仅在 refs 未
        // 算出时兜底占位。
        else if (field.hex_value) return this.parseHexBytes(field.hex_value);
        else value = params.value || 0;

        // E1-3 (B4): SCALED_DECIMAL → (value+offset)*factor 定标后再编码。
        // factor/offset 空/缺省/非有限 → 1/0（恒等回归：裸整数路径不变）；
        // 矛盾 type（string/float/hex，算子模板不设置）不参与定标，保持现行为。
        // 与 backend orchestrator.encode_scaled byte-equal。
        if (op === 'SCALED_DECIMAL' && ['', 'number'].includes(String(params.type ?? '').toLowerCase())) {
            const toNum = (x) => (typeof x === 'number' ? x : Number(String(x ?? '').trim()));
            const offRaw = params.offset === undefined || params.offset === null || params.offset === '' ? NaN : toNum(params.offset);
            const facRaw = params.factor === undefined || params.factor === null || params.factor === '' ? NaN : toNum(params.factor);
            const off = Number.isFinite(offRaw) ? offRaw : 0;
            const fac = Number.isFinite(facRaw) ? facRaw : 1;
            const base = Number(value);
            const scaled = (base + off) * fac;
            value = Number.isFinite(scaled) ? scaled : 0;
        }

        // E1-6 (B8): TIME_ACCUMULATOR → floor((now − base_time)/1000) 的秒数，
        // 再走通用整数路径（abs/mod 同口径）。Current = 墙钟（now 经 encodeInstruction
        // 第 4 参 opts.now 注入、缺省 Date.now()；后端 fields_to_blocks(now=…) 同名
        // 同单位 ms），inputs/value 不参与 —— 语义即算子描述 "Current - BaseTime"。
        // base_time 缺失/非法（契约外配置）→ 不覆盖，保持现状回落 value 路径。
        // 与 backend orchestrator.encode_time_accumulator byte-equal。
        if (op === 'TIME_ACCUMULATOR' && ['', 'number'].includes(String(params.type ?? '').toLowerCase())) {
            const baseMs = Date.parse(params.base_time ?? '');
            if (Number.isFinite(baseMs)) {
                const nowMs = Number.isFinite(now) ? now : Date.now();
                value = Math.floor((nowMs - baseMs) / 1000);
            }
        }

        // E1-6 (B8): AUTO_COUNTER → (Current + Step) % Max（语义即算子描述
        // "(Current+Step)%Max"）。Current 取 computed > input > 静态 value（非空）
        // > start_val（模板初值），解析 = _floor_numeric 同款；step 缺省/非法 → 0；
        // max 缺省/非法/≤0 → 不回绕。回绕用双重取模 ((n%max)+max)%max ——
        // JS/Python 负余数差异被消平，byte-equal；无回绕负值走通用路径 abs
        // （双端同口径）。跨帧自动递增状态机不在编码器（纯函数），由调用方每帧
        // 推进 value。与 backend orchestrator.encode_auto_counter byte-equal。
        if (op === 'AUTO_COUNTER' && ['', 'number'].includes(String(params.type ?? '').toLowerCase())) {
            const floorNum = (x) => {
                if (typeof x === 'number') { const f = Math.floor(x); return Number.isFinite(f) ? f : 0; }
                if (typeof x === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(x.trim())) {
                    const f = Math.floor(Number(x.trim())); return Number.isFinite(f) ? f : 0;
                }
                return 0;
            };
            const hasCur = params.value !== undefined && params.value !== null && params.value !== '';
            const rawCur = computedVal !== undefined ? computedVal
                : inputValue !== undefined ? inputValue
                    : (hasCur ? params.value : params.start_val);
            let n = floorNum(rawCur) + floorNum(params.step);
            const mxRaw = params.max;
            const mx = typeof mxRaw === 'number' ? mxRaw
                : (typeof mxRaw === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(mxRaw.trim())
                    ? Number(mxRaw.trim()) : NaN);
            if (Number.isFinite(mx) && mx > 0) n = ((n % mx) + mx) % mx;
            value = n;
        }

        // 1. Strings —— N2 (G2): op=STRING 或存量 type=string 同走定长文本编码。
        // byte_len>0（floor 归一）→ 定长 pad/截断，pad_char 按 2 位以内 hex 严格
        // 解析（非法/缺省 0x00）；byte_len 缺失/0 → 变长原样（契约外，W1 提醒，
        // 与 BE to_block 的 byte_len>0 分支闸对齐）。ascii 按 code point &0xFF
        // （`for...of` 迭代码点，与 Python ord() byte-equal；>0xFF 脏值由校验
        // W STRING_NON_ASCII 提醒改 utf8）；utf8 走 TextEncoder（孤立代理项 →
        // U+FFFD）。与 backend orchestrator.encode_string byte-equal（双向量表锚定）。
        if (op === 'STRING' || params.type === 'string') {
            const str = String(value || '');
            let bytes = [];
            if (String(params.encoding ?? 'ascii').toLowerCase() === 'utf8') {
                bytes = Array.from(new TextEncoder().encode(str));
            } else {
                for (const ch of str) bytes.push(ch.codePointAt(0) & 0xFF);
            }
            const rawLen = Number(field.byte_len ?? field.byte_length);
            if (Number.isFinite(rawLen) && rawLen > 0) {
                const target = Math.floor(rawLen);
                const padRaw = params.pad_char === undefined || params.pad_char === null
                    ? '' : String(params.pad_char);
                const padByte = (padRaw.length > 0 && padRaw.length <= 2 && /^[0-9A-Fa-f]+$/.test(padRaw))
                    ? parseInt(padRaw, 16) : 0;
                if (bytes.length > target) bytes = bytes.slice(0, target);
                else while (bytes.length < target) bytes.push(padByte);
            }
            return bytes;
        }
        // 2. Float/Decimal
        if (params.type === 'float' || params.type === 'decimal') {
            const farr = new Float32Array(1);
            farr[0] = value || 0;
            const barr = new Uint8Array(farr.buffer);
            return Array.from(barr).reverse();
        }
        // 3. HEX_RAW (Input driven)
        if (op === 'HEX_RAW' || params.type === 'hex') {
            if (typeof value === 'string') return this.parseHexBytes(value);
            // Number fallthrough
        }

        // 3.5 BITFIELD: pack sub-bits -> integer -> fixed-width bytes
        if (op === 'BITFIELD') {
            let packed;
            if (inputValue !== undefined || computedVal !== undefined) {
                // Runtime input/computed value overrides static bit defaults
                packed = Math.floor(Number(value) || 0);
            } else {
                packed = 0;
                const subBits = Array.isArray(field.bits) ? field.bits : [];
                subBits.forEach(bit => {
                    const start = Number.isFinite(bit.start_bit) ? bit.start_bit : 0;
                    const len = Math.max(1, Number.isFinite(bit.bit_len) ? bit.bit_len : 1);
                    const mask = len >= 32 ? 0xFFFFFFFF : ((1 << len) - 1);
                    const raw = Number.isFinite(bit.default_val) ? bit.default_val : 0;
                    packed |= (raw & mask) << start; // JS bitwise is 32-bit; fields <= 32 bits are the common case
                });
            }
            // Treat packed result as unsigned
            packed = packed >>> 0;
            const hexStr = packed.toString(16).toUpperCase();
            const target = byteLen * 2;
            return this.parseHexBytes(hexStr.padStart(target, '0').slice(-target));
        }

        // 4. Standard Integers
        // Handle negative? standard hex conversion usually implies unsigned unless specified
        if (byteLen === 0) return [];

        // E1-1 (B5): INT_SIGNED → 按位宽两补码（mod 2^(8*byteLen)），替代 Math.abs。
        // 解析口径必须与 backend/core/orchestrator.py::encode_int_signed byte-equal：
        // number 取 floor（非有限 → 0）；严格十进制字符串（trim 后 [+-]?d+.d*|.d+）
        // 取 floor，其余（"FF"/"0x.."/布尔/null）→ 0。加工页 hex 输入的补码写法
        // （如 FF）已在 RunnerFieldTree parseInt(x,16) 落库为 number，走 number 路径。
        if (op === 'INT_SIGNED') {
            let n = 0;
            if (typeof value === 'number') {
                const f = Math.floor(value);
                n = Number.isFinite(f) ? f : 0;
            } else if (typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) {
                const f = Math.floor(Number(value.trim()));
                n = Number.isFinite(f) ? f : 0;
            }
            const masked = BigInt(n) & ((1n << BigInt(byteLen * 8)) - 1n);
            const signedHex = masked.toString(16).toUpperCase().padStart(byteLen * 2, '0');
            return this.parseHexBytes(signedHex);
        }

        // E1-3 (B3): BCD_CODE → 十进制数字逐 nibble 打包（大端 packed BCD）。
        // 解析口径与 INT_SIGNED 同款（number floor 非有限→0 / 严格十进制字符串
        // floor / 其余→0），floor 后取绝对值（负号无 nibble 表达，与通用路径
        // abs 口径一致）；超长截高位保低 2n 位数字，高位补 0。与 backend
        // orchestrator.encode_bcd byte-equal，向量表锚定双端测试（改一必改二）。
        if (op === 'BCD_CODE') {
            let n = 0;
            if (typeof value === 'number') {
                const f = Math.floor(value);
                n = Number.isFinite(f) ? f : 0;
            } else if (typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) {
                const f = Math.floor(Number(value.trim()));
                n = Number.isFinite(f) ? f : 0;
            }
            const nibbleCount = byteLen * 2;
            const digits = String(Math.abs(n));
            const kept = digits.length > nibbleCount ? digits.slice(-nibbleCount) : digits;
            return this.parseHexBytes(kept.padStart(nibbleCount, '0'));
        }

        // E1-4 (B2): FLOAT_IEEE → IEEE 754 float32 大端（网络序），恒 4 字节。
        // 仅 byte_len===4（bits=32）且规范 type（缺省/number）时生效；bits=64
        // （byte_len=8）与矛盾 type 不在范围，保持现状（同 E1-1 原则）。
        // 解析口径：number 原样 / 严格十进制字符串（同 E1-1 正则）→ Number /
        // bool → 1|0 / 其余 → 0；非有限（NaN/±Infinity/超范围）→ 0；有限值经
        // Float32Array 转换（超 f32 表示范围 → ±Infinity，IEEE 溢出）。
        // 与 backend orchestrator.encode_float_ieee byte-equal，向量表锚定双端测试。
        if (op === 'FLOAT_IEEE' && byteLen === 4
            && ['', 'number'].includes(String(params.type ?? '').toLowerCase())) {
            let base = 0;
            if (typeof value === 'number') base = value;
            else if (typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) base = Number(value.trim());
            else if (typeof value === 'boolean') base = value ? 1 : 0;
            else base = 0;
            if (!Number.isFinite(base)) base = 0;
            const farr = new Float32Array(1);
            farr[0] = base;
            return Array.from(new Uint8Array(farr.buffer)).reverse(); // 平台小端 → 大端
        }

        const hex = Math.abs(Math.floor(value)).toString(16).toUpperCase();
        const targetLen = byteLen * 2;
        // slice(-0) returns the whole string, which is wrong for 0 length. 
        // But we handled byteLen===0 above.
        const padded = hex.padStart(targetLen, '0').slice(-targetLen);
        return this.parseHexBytes(padded);
    },

    /**
     * E1-5 (B7): repeat 展开次数 —— 组字段专用。
     * - NONE/缺省/未知类型 → 1；
     * - FIXED → repeat_count 须为有限 number（typeof 严格，同 BE isinstance 防御
     *   口径；normalizeInstruction 已归一），max(0, floor(n))；
     * - DYNAMIC → 计数源字段值（computedValues > inputs > 静态
     *   parameter_config.value），解析口径 = _floor_numeric 同款（number floor
     *   非有限→0 / 严格十进制字符串 floor / 其余→0），max(0, n)，ref 缺失 → 0。
     * 与 backend datahub.to_block 的 resolve byte-equal（改一必改二）。
     */
    _repeatCount: function (field, inputs, computedValues, allFields) {
        const rt = String(field.repeat_type || 'NONE').toUpperCase();
        if (rt === 'FIXED') {
            const c = field.repeat_count;
            if (typeof c !== 'number' || !Number.isFinite(c)) return 1;
            return Math.max(0, Math.floor(c));
        }
        if (rt === 'DYNAMIC') {
            const v = this._refValue(field.repeat_ref_id, inputs, computedValues, allFields);
            let n = 0;
            if (typeof v === 'number') {
                const fl = Math.floor(v);
                n = Number.isFinite(fl) ? fl : 0;
            } else if (typeof v === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(v.trim())) {
                const fl = Math.floor(Number(v.trim()));
                n = Number.isFinite(fl) ? fl : 0;
            }
            return Math.max(0, n);
        }
        return 1;
    },

    /**
     * N3 (G1): 值链取值 —— computedValues > inputs > 静态 parameter_config.value。
     * _repeatCount(DYNAMIC) 与 presence 判定共用（抽公共 helper，改一必改二；
     * BE 静态链仅最后一段 pc.value，inputs/computed 覆盖为 FE-only 运行期行为）。
     */
    _refValue: function (refId, inputs, computedValues, allFields) {
        if (computedValues && computedValues[refId] !== undefined) return computedValues[refId];
        if (inputs && inputs[refId] !== undefined) return inputs[refId];
        const refField = (allFields || []).find(f => f.id === refId);
        return refField && refField.parameter_config ? refField.parameter_config.value : undefined;
    },

    /**
     * N3 (G1): presence 条件存在判定 —— true=命中（照发）、false=未命中（0 字节）。
     * - 比较 String(refVal) === String(expect) 归一（数值 1 命中 '1'，不 trim）；
     * - fail-open → true：presence 非对象 / 缺 ref_id / 缺 expect（undefined/
     *   null/''）/ 值链不可解析（ref 悬空或无静态值且运行输入也没有）——
     *   半成品配置不吞字节，防数据丢失优于严格过滤（W PRESENCE_INCOMPLETE /
     *   PRESENCE_REF_MISSING 提醒核对）。
     * - 层级：presence 先于 repeat 展开（emitNode 入口），组未命中整棵子树
     *   0 字节；命中组内子字段各自独立判（父命中不豁免子）。
     * 与 backend datahub._presence_hit byte-equal（改一必改二）。
     */
    _presenceHit: function (field, inputs, computedValues, allFields) {
        const pres = field.parameter_config ? field.parameter_config.presence : undefined;
        if (!pres || typeof pres !== 'object' || Array.isArray(pres)) return true;
        if (pres.ref_id === undefined || pres.ref_id === null || pres.ref_id === '') return true;
        if (pres.expect === undefined || pres.expect === null || pres.expect === '') return true;
        const refVal = this._refValue(pres.ref_id, inputs, computedValues, allFields);
        if (refVal === undefined || refVal === null) return true; // fail-open：不可解析
        return String(refVal) === String(pres.expect);
    },

    parseHexBytes: function (hexStr) {
        const clean = hexStr.replace(/\s/g, '');
        const bytes = [];
        for (let i = 0; i < clean.length; i += 2) {
            bytes.push(parseInt(clean.substr(i, 2), 16));
        }
        return bytes;
    },


    /**
     * Resolves all derived fields (CALCULATED / Formulas / Checksums) based on current inputs.
     */
    resolveDependencies: function (instruction, inputs) {
        const computedValues = {};
        if (!instruction) return computedValues;

        const rawFields = instruction.fields || instruction.blocks || [];

        // CRITICAL: We need ALL nodes (including parents) to resolve Group references
        const allFieldsMap = this.flattenAll(rawFields);

        // --- PASS 0: CALCULATE SIZES (Bottom-Up Approach required for Groups?) ---
        // Actually, we can just calculate leaf sizes, then Aggregate for groups.
        const fieldSizes = {};

        // 0.1 Leaf Sizes
        allFieldsMap.forEach(field => {
            const params = field.parameter_config || {};
            // R1: 组（fields/children 非空）跳过 → 0.2 汇总；空容器（children:[]）
            // 已知 0；slot 占位归零（对齐 LengthHandler:29 / ChecksumHandler:27
            // 排除 slot 的发射口径，编码期 fieldSizes 即 0）。
            if (field.fields?.length > 0 || field.children?.length > 0) return;
            // N3 (G1): presence 未命中 → 尺寸 0（slot=0 先例；判定先于 repeat，
            // 命中组内子字段在各自解析中独立判 —— 父命中不豁免子）。
            if (!this._presenceHit(field, inputs, computedValues, allFieldsMap)) {
                fieldSizes[field.id] = 0;
                return;
            }
            if (field.type === 'container') { fieldSizes[field.id] = 0; return; }
            if (field.type === 'slot') { fieldSizes[field.id] = 0; return; }

            // Default —— byte_len（指令字段）|| byte_length（协议节点），皆缺/0 → 1。
            // E1-3 的 byte_len=0 归一契约不变；协议卡自此读 byte_length（R1 修
            // 死 config 缺口），与 computeByteOffsets 的 byte_len ?? byte_length 同尺。
            let size = field.byte_len || field.byte_length || 1;

            if (field.op_code === 'STRING' || params.type === 'string') {
                // N2 (G2): 定长文本的长度 = 实际发射字节数（byte_len），不再按
                // 字符数——'A'@2B 输入短于定长时 LENGTH_CALC 旧口径会少算 1B。
                // byte_len 缺失/0 → 保持变长字符数口径（契约外，W1 提醒）。
                const rawLen = Number(field.byte_len ?? field.byte_length);
                if (Number.isFinite(rawLen) && rawLen > 0) {
                    size = Math.floor(rawLen);
                } else {
                    const val = inputs[field.id] || params.value || '';
                    size = val.length;
                }
            } else if (field.op_code === 'HEX_RAW') {
                const val = inputs[field.id] || params.hex || '';
                if (typeof val === 'string') size = Math.ceil(val.replace(/\s/g, '').length / 2);
            }
            fieldSizes[field.id] = size;
        });

        // 0.2 Group Sizes (Recursive Function)
        const getOrCalcSize = (item) => {
            if (fieldSizes[item.id] !== undefined) return fieldSizes[item.id];

            // N3 (G1): presence 未命中的组 → 尺寸 0（整棵子树不计，判定先于
            // repeat 展开）；命中组内子字段在 0.1/嵌套 getOrCalcSize 独立判。
            if (!this._presenceHit(item, inputs, computedValues, allFieldsMap)) {
                fieldSizes[item.id] = 0;
                return 0;
            }

            // R1: children 树组与 fields 组同权（0.1 只跳过非空组，落此必非空）。
            const kids = (item.fields?.length > 0) ? item.fields : item.children;
            if (kids && kids.length > 0) {
                let total = 0;
                kids.forEach(child => total += getOrCalcSize(child));
                fieldSizes[item.id] = total;
                return total;
            }
            return 0; // Should have been caught in 0.1 if leaf
        };

        // Trigger calculation for all top-level items (which cascades down)
        // Or just map over allFieldsMap again? Mapping all ensures we catch nested groups.
        allFieldsMap.forEach(f => getOrCalcSize(f));


        // --- PASS 1: RESOLVE LENGTH_CALC ---
        allFieldsMap.forEach(field => {
            const params = field.parameter_config || {};
            // R1 对称闸：指令侧 LENGTH_CALC 算子与协议侧 length 卡（无 op_code，
            // 认 parameter_config.type='length' —— A1 createBlock 初始化保证）
            // 同走 refs Σ / formula 路径；width 用卡自身 byte_length 定宽。
            if (field.op_code !== 'LENGTH_CALC' && params.type !== 'length') return;
            const refs = params.refs || [];

            // Build Symbol Table for Formula (Name/ID -> Size)
            const sizeTable = {};
            allFieldsMap.forEach(f => {
                const name = f.name || f.label;
                sizeTable[name] = fieldSizes[f.id] || 0;
                sizeTable[f.id] = fieldSizes[f.id] || 0;
            });

            let result = 0;
            if (params.formula && params.formula !== 'auto') {
                result = evaluateFormula(params.formula, sizeTable);
            } else {
                if (refs.length > 0) {
                    // Simply sum the sizes of referenced fields (which may be Groups)
                    result = refs.reduce((acc, refId) => acc + (fieldSizes[refId] || 0), 0);
                }
            }
            computedValues[field.id] = result;
            // Update this field's size in the map in case it's referenced later?
            // Typically Length itself is fixed size (e.g. 2 bytes), so fieldSizes[field.id] is already correct (2).
            // The *Computed Value* is what changes, not the Field Size.
        });

        // --- PASS 2: RESOLVE CHECKSUM & CALC ---
        // Need to respect calculation order. Simple approach: Calculate everything.
        allFieldsMap.forEach(field => {
            if (field.op_code === 'LENGTH_CALC') return; // Done

            const params = field.parameter_config || {};

            if (field.op_code === 'CHECKSUM_CRC' || params.type === 'checksum') {
                const refs = params.refs || [];
                if (refs.length > 0) {
                    let allBytes = [];
                    refs.forEach(refId => {
                        const refField = allFieldsMap.find(f => f.id === refId);
                        if (refField) {
                            // Recursive Byte Fetching (E1-5 note: a leaf ref inside
                            // a repeat group feeds ONE copy — the backend checksum
                            // range is first-start→first-end, which likewise spans a
                            // single copy, keeping both ends byte-equal; a GROUP ref
                            // expands its own repeat in _encodeFieldBytes).
                            const bytes = this._encodeFieldBytes(refField, inputs, computedValues, allFieldsMap);
                            allBytes = allBytes.concat(bytes);
                        }
                    });
                    const algo = params.algorithm || ChecksumAlgo.CRC_16_MODBUS;
                    computedValues[field.id] = calculateChecksum(algo, allBytes);
                }
            }
            else if (field.op_code === 'CALCULATED') {
                const valueTable = {};
                allFieldsMap.forEach(f => {
                    const name = f.name || f.label;
                    // Only meaningful for scalar fields. For Groups, what is "value"? 
                    // Usually formulas don't math on Groups directly unless custom.
                    // We'll skip deep group objects.
                    if (!f.fields || f.fields.length === 0) {
                        let val = inputs[f.id];
                        if (computedValues[f.id] !== undefined) val = computedValues[f.id];
                        else if (val === undefined) val = (f.parameter_config?.value || 0);
                        valueTable[name] = val;
                        valueTable[f.id] = val;
                    }
                });
                if (params.formula) {
                    computedValues[field.id] = evaluateFormula(params.formula, valueTable);
                }
            }
        });

        return computedValues;
    },

    /**
     * Generates the final Hex string.
     */
    encodeInstruction: function (instruction, inputs, computedValues, opts) {
        let hexParts = [];
        let byteMap = [];
        let currentByteIndex = 0;

        // E1-6 (B8): 墙钟注入 —— TIME_ACCUMULATOR 的 Current 恒取此刻（ms）。
        // opts.now 供测试/回放固定时间（后端 fields_to_blocks(now=…) 同名同义，
        // 双端注入同值 → byte-equal）；缺省 Date.now()。
        const now = Number.isFinite(opts?.now) ? opts.now : Date.now();

        if (!instruction) return { hexString: '', byteMap: [] };

        const rawFields = instruction.fields || instruction.blocks || [];
        // Flatten ALL to encode
        const allFields = this.flattenAll(rawFields);

        // E1-5 (B7): emit by TREE walk so repeat copies interleave correctly —
        // (ab)×N, never (a×N)(b×N). Children come from nested `fields` when
        // present, else from parent_id links (flat input); the recursion carries
        // the effective copy count top-down (nested groups multiply), mirroring
        // backend datahub.to_block resolve + orchestrator._flatten_recursive.
        const bySeq = (a, b) => (a.sequence ?? a.order ?? 0) - (b.sequence ?? b.order ?? 0);
        const idSet = new Set(allFields.map(f => f.id));
        const kidsOf = new Map();
        allFields.forEach(f => {
            const pid = (f.parent_id != null && idSet.has(f.parent_id)) ? f.parent_id : null;
            if (!kidsOf.has(pid)) kidsOf.set(pid, []);
            kidsOf.get(pid).push(f);
        });
        kidsOf.forEach(list => list.sort(bySeq));
        const referenced = new Set();
        kidsOf.forEach((list, pid) => {
            if (pid != null) list.forEach(k => referenced.add(k.id));
        });
        allFields.forEach(f => {
            (f.fields || f.blocks || f.children || []).forEach(c => referenced.add(c.id));
        });
        const roots = allFields.filter(f => !referenced.has(f.id));

        const childrenOf = (field) => {
            if (field.fields && field.fields.length > 0) return [...field.fields].sort(bySeq);
            // R1: children 树归属（协议节点无 parent_id / 合并树 cloneBlocks 不
            // 前缀化 parent_id → kidsOf 必失配）走 children 数组；空容器返回 []
            // —— 走组路径发 0 字节，不当叶产脏 00。
            if (field.children && field.children.length > 0) return [...field.children].sort(bySeq);
            if (field.type === 'container') return [];
            const kids = kidsOf.get(field.id);
            return kids && kids.length > 0 ? kids : null;
        };

        const emitNode = (field, copies) => {
            if (copies <= 0) return;
            // N3 (G1): presence 判定先于 repeat 展开（组未命中连 ×N 都不展开，
            // 整棵子树 0 字节；命中组内子字段在各自 emitNode 独立判）。
            if (!this._presenceHit(field, inputs, computedValues, allFields)) return;
            const kids = childrenOf(field);
            if (kids) {
                // Group: own repeat multiplies how many full child copies follow.
                const n = this._repeatCount(field, inputs, computedValues, allFields) * copies;
                if (n <= 0) return;
                for (let c = 0; c < n; c++) {
                    kids.forEach(k => emitNode(k, 1));
                }
                return;
            }
            const bytes = this.getFieldBytes(field, inputs, computedValues, allFields, now);
            const hexStr = bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
            const byteLen = bytes.length;
            for (let c = 0; c < copies; c++) {
                hexParts.push(hexStr);
                byteMap.push({ start: currentByteIndex, end: currentByteIndex + byteLen, fieldId: field.id });
                currentByteIndex += byteLen;
            }
        };

        roots.forEach(f => emitNode(f, 1));

        const rawFull = hexParts.join('');
        const pretty = rawFull.match(/.{1,2}/g)?.join(' ') || '';

        return {
            hexString: pretty,
            byteMap
        };
    }
};

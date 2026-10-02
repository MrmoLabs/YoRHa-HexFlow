import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import InstructionProcessor from '../InstructionProcessor';
import wrapVec from '../../../../vectors/wrap.json';
import { loadVectors } from '../../../../vectors/vectors.js';

// 批次一 (D4-A): 加工页 wrap 状态机（ok / none / failed / missing 降级裸发）
// + 封装预览 300ms 防抖 compileWrapped + TRANSMIT / TransactionPanel 双路带 wrap。
// CP3 3a (D13): 降级链三级（配方 → 默认协议 → 裸发）+ 分层堆叠预览 + 失效徽标；
// 三层帧主向量单一真相源 = vectors/wrap.json · 表 three（与后端
// test_frame_recipes / test_wrap_api 三处同读，改一必改三）。

vi.mock('../../api', () => ({
    api: {
        getBindings: vi.fn(),
        getRecipes: vi.fn(),
        getOperatorTemplates: vi.fn(),
        dispatchPayload: vi.fn(),
        compileWrapped: vi.fn(),
        getResponseSpec: vi.fn(),
        saveResponseSpec: vi.fn(),
        sendTransaction: vi.fn(),
        exportHexFile: vi.fn()
    }
}));

import { api } from '../../api';

// CP3 3a 共享向量：三层配方帧（改一必改三）
const THREE = loadVectors(wrapVec.three);
const RECIPE_ID = 'recipe-three';
const RECIPE = {
    id: RECIPE_ID, name: '三层配方', description: '', version: 1,
    instruction_id: 'inst-1',
    stages: THREE.layers.map(layer => ({
        protocol_id: layer.protocol_id, slot_ids: [layer.slot_id],
        definition_hash: 'sha256:fixture'
    }))
};

// 编译响应的 stages 回显（向量期望值 + 服务端会补的 protocol_label / hash 字段）。
// 串行编译结果由后端同向量钉死，FE 断言渲染取**同一张表** → 改向量三端同动。
const recipeStages = (staleIndex = null) => THREE.expect.stages.map(stage => ({
    index: stage.index,
    protocol_id: stage.protocol_id,
    protocol_label: THREE.layers[stage.index].label,
    hex: stage.hex,
    total_length: stage.total_length,
    delta_bytes: stage.delta_bytes,
    definition_hash: 'sha256:fixture',
    logic: stage.logic,
    stale: stage.index === staleIndex,
    warnings: stage.index === staleIndex ? ['配方已失效：应用壳 定义已变更，请重新保存配方'] : []
}));

const recipeCompileResult = (staleIndex = null) => ({
    hex_string: THREE.expect.hex,
    total_length: THREE.expect.total_length,
    warnings: staleIndex === null
        ? []
        : [`第 ${staleIndex + 1} 层：配方已失效：应用壳 定义已变更，请重新保存配方`],
    recipe_id: RECIPE_ID,
    stages: recipeStages(staleIndex)
});

const PROTOCOLS = [{
    id: 'p-1', label: '外壳协议', type: 'container',
    children: [
        { id: 'h', label: '帧头', type: 'fixed', byte_length: 1, hex_value: 'AA', children: [] },
        { id: 's', label: '槽', type: 'slot', byte_length: 0, children: [] }
    ]
}];

const INSTRUCTIONS = [
    {
        id: 'inst-1', name: '开门指令',
        fields: [
            { id: 'f1', parent_id: null, sequence: 0, name: '命令字',
                op_code: 'HEX_RAW', byte_length: 1, parameter_config: { hex: '01' } }
        ]
    },
    { id: 'inst-2', name: '关门指令', fields: [] },
    // 第 4 批：定长可编辑 hex（h1）+ TIME 字段（h2）
    {
        id: 'inst-3', name: '心跳指令',
        fields: [
            { id: 'h1', parent_id: null, sequence: 0, name: '命令字',
                op_code: 'INPUT', byte_length: 1, parameter_config: {} },
            { id: 'h2', parent_id: null, sequence: 1, name: '运行秒数',
                op_code: 'TIME_ACCUMULATOR', byte_length: 4,
                parameter_config: { base_time: '2026-01-01T00:00:00' } }
        ]
    },
    // 批 3：BITFIELD 子位录入 —— b1 位域 MODE(bit0..1, 默认1) / EN(bit2, 默认1)
    // → 默认打包 0x05；无主位 bit3..7 留空（间隙位保留的验证靶子）
    {
        id: 'inst-6', name: '位域指令',
        fields: [
            { id: 'b1', parent_id: null, sequence: 0, name: '控制位',
                op_code: 'BITFIELD', byte_length: 1, parameter_config: {},
                bits: [
                    { id: 'ba', sequence: 0, bit_name: 'MODE', start_bit: 0, bit_len: 2, default_val: 1 },
                    { id: 'bb', sequence: 1, bit_name: 'EN', start_bit: 2, bit_len: 1, default_val: 1 }
                ] }
        ]
    },
    // 批 1：字段级十进制录入 —— d1 走 dec 通道（2 字节，值域 0..65535），
    // d2 缺省保持 hex 通道（存量对照组）
    {
        id: 'inst-5', name: '十进制指令',
        fields: [
            { id: 'd1', parent_id: null, sequence: 0, name: '速度',
                op_code: 'INPUT', byte_length: 2, parameter_config: { input_base: 'dec' } },
            { id: 'd2', parent_id: null, sequence: 1, name: '模式',
                op_code: 'INPUT', byte_length: 1, parameter_config: {} }
        ]
    },
    // 第 4 批 #2 修复回归：两层嵌套（头组 > 内组 > 叶）+ 根级叶
    // 字节序：段头 AA [0,1) · 段尾 00 [1,2) · 尾字节 00 [2,3)
    {
        id: 'inst-4', name: '嵌套指令',
        fields: [
            { id: 'g1', parent_id: null, sequence: 0, name: '头组',
                op_code: 'BLOCK', parameter_config: {}, byte_length: 0 },
            { id: 'g2', parent_id: 'g1', sequence: 0, name: '内组',
                op_code: 'BLOCK', parameter_config: {}, byte_length: 0 },
            { id: 'n1', parent_id: 'g2', sequence: 0, name: '段头',
                op_code: 'HEX_RAW', byte_length: 1, parameter_config: { hex: 'AA' } },
            { id: 'n2', parent_id: 'g2', sequence: 1, name: '段尾',
                op_code: 'INPUT', byte_length: 1, parameter_config: {} },
            { id: 'n3', parent_id: null, sequence: 1, name: '尾字节',
                op_code: 'INPUT', byte_length: 1, parameter_config: {} }
        ]
    }
];

const DEFAULT_ROW = {
    id: 'b-1', protocol_id: 'p-1', instruction_id: 'inst-1',
    label: '默认封装', slot_order: 0, slot_id: 's', is_default: true, priority: 0
};

const OK_RECORD = {
    id: 1700000000001,
    timestamp: '2026-09-24T00:00:00Z',
    channel: 'LOOPBACK',
    status: 'OK',
    byte_count: 3,
    hex_string: 'AA 00 01',
    instruction_name: '开门指令',
    instruction_id: 'inst-1',
    spec_source: 'default',
    broadcast: false,
    echo: 'AA0001',
    attempts: [
        { n: 1, status: 'OK', sent: 'AA 00 01', received: 'AA 00 01', rtt_ms: 0.4, reasons: [], error: null }
    ],
    stats: { attempts: 1, rtt_ms_last: 0.4, rtt_ms_avg: 0.4, rtt_ms_max: 0.4 }
};

const renderPage = (protocols = PROTOCOLS) => render(
    <InstructionProcessor
        instructions={INSTRUCTIONS}
        setInstructions={vi.fn()}
        reloadInstructions={vi.fn()}
        protocols={protocols}
    />
);

// hook 自动选中首条指令 → 标题与侧栏同名；点选限在侧栏 aside 内消歧
const sidebar = () => within(document.querySelector('aside'));

const selectInstruction = async () => {
    fireEvent.click(await sidebar().findByText('开门指令'));
};

describe('InstructionProcessor wrap 状态机（批次一 D4-A）', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        api.getResponseSpec.mockRejectedValue(
            Object.assign(new Error('nf'), { response: { status: 404 } })
        );
        api.getOperatorTemplates.mockResolvedValue([]);
        api.getRecipes.mockResolvedValue([]);
        api.dispatchPayload.mockResolvedValue({ id: 1, status: 'SENT', byte_count: 3 });
        api.compileWrapped.mockResolvedValue({ hex_string: 'AA 00 01', total_length: 3, warnings: [] });
        api.sendTransaction.mockResolvedValue(OK_RECORD);
    });

    it('ok：默认绑定解析 → 默认开自动预览（300ms 防抖）→ TRANSMIT/事务同带 wrap', async () => {
        api.getBindings.mockResolvedValue([DEFAULT_ROW]);
        renderPage();
        await selectInstruction();

        // 状态机 ok 且开关默认开（挂载按 ?instruction_id= 过滤取 is_default 行）
        await screen.findByText(/WRAP ACTIVE/);
        expect(api.getBindings).toHaveBeenCalledWith('inst-1');

        // 默认开 → 300ms 防抖自动调 compileWrapped（内核 hex + 默认槽）
        await waitFor(() => expect(api.compileWrapped).toHaveBeenCalledTimes(1), { timeout: 2000 });
        expect(api.compileWrapped).toHaveBeenCalledWith({
            protocolId: 'p-1', payloads: ['01'], slotIds: ['s'], startOrder: 0
        });
        // 预览面板回显封装后帧
        await screen.findByText('AA 00 01', undefined, { timeout: 2000 });

        // TRANSMIT 带 wrap（内核载荷出线，后端套壳）
        fireEvent.click(screen.getByRole('button', { name: /TRANSMIT_DATA/ }));
        await waitFor(() => expect(api.dispatchPayload).toHaveBeenCalledTimes(1));
        expect(api.dispatchPayload).toHaveBeenCalledWith('01', '开门指令', {
            protocol_id: 'p-1', slot_id: 's', slot_order: 0
        });

        // TransactionPanel 同带 wrap（开关联动）
        fireEvent.click(screen.getByRole('button', { name: /SEND_TRANSACTION/ }));
        await waitFor(() => expect(api.sendTransaction).toHaveBeenCalledTimes(1));
        expect(api.sendTransaction.mock.calls[0][0].wrap).toEqual({
            protocol_id: 'p-1', slot_id: 's', slot_order: 0
        });
    });

    it('开关切裸发：ok 态点关 → TRANSMIT 带 null 且预览请求被取消', async () => {
        api.getBindings.mockResolvedValue([DEFAULT_ROW]);
        renderPage();
        await selectInstruction();
        await screen.findByText(/WRAP ACTIVE/);

        // 300ms 防抖前点关 → 清定时器，compileWrapped 不发
        fireEvent.click(screen.getByRole('button', { name: /WRAP ●/ }));
        await screen.findByText(/WRAP READY/);
        expect(api.compileWrapped).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: /TRANSMIT_DATA/ }));
        await waitFor(() => expect(api.dispatchPayload).toHaveBeenCalledTimes(1));
        expect(api.dispatchPayload).toHaveBeenCalledWith('01', '开门指令', null);
    });

    it('none：无默认行 → 开关禁用、TRANSMIT 裸发且不调 compileWrapped', async () => {
        api.getBindings.mockResolvedValue([]);
        renderPage();
        await selectInstruction();

        await screen.findByText(/NO DEFAULT BINDING/);
        expect(api.getBindings).toHaveBeenCalledWith('inst-1');
        expect(screen.getByRole('button', { name: /WRAP ○/ }).disabled).toBe(true);

        fireEvent.click(screen.getByRole('button', { name: /TRANSMIT_DATA/ }));
        await waitFor(() => expect(api.dispatchPayload).toHaveBeenCalledTimes(1));
        expect(api.dispatchPayload).toHaveBeenCalledWith('01', '开门指令', null);
        expect(api.compileWrapped).not.toHaveBeenCalled();
    });

    it('failed：绑定拉取失败 → 降级裸发并挂失败态', async () => {
        api.getBindings.mockRejectedValue(new Error('backend down'));
        renderPage();
        await selectInstruction();

        await screen.findByText(/BINDING LOAD FAILED/);
        expect(screen.getByRole('button', { name: /WRAP ○/ }).disabled).toBe(true);
    });

    it('missing：默认行协议不在册 → 降级裸发', async () => {
        api.getBindings.mockResolvedValue([{ ...DEFAULT_ROW, protocol_id: 'ghost' }]);
        renderPage();
        await selectInstruction();

        await screen.findByText(/PROTOCOL MISSING/);
        expect(screen.getByRole('button', { name: /WRAP ○/ }).disabled).toBe(true);
    });

    it('换指令 → 按新 instruction_id 重新解析默认绑定', async () => {
        api.getBindings.mockResolvedValue([]);
        renderPage();
        await selectInstruction();
        await waitFor(() => expect(api.getBindings).toHaveBeenCalledWith('inst-1'));

        fireEvent.click(await sidebar().findByText('关门指令'));
        await waitFor(() => expect(api.getBindings).toHaveBeenCalledWith('inst-2'));
    });
});

// 指令加工编辑反馈（第 4 批 #1/#2/#4）：TIME 字段不再标 READ_ONLY、
// 点击字段高亮字节流 + 读数条、定长 hex 截断与 n/N BYTES 徽标。
describe('指令加工编辑反馈（第 4 批）', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        api.getResponseSpec.mockRejectedValue(
            Object.assign(new Error('nf'), { response: { status: 404 } })
        );
        api.getOperatorTemplates.mockResolvedValue([]);
        api.getRecipes.mockResolvedValue([]);
        api.getBindings.mockResolvedValue([]);
        api.dispatchPayload.mockResolvedValue({ id: 1, status: 'SENT', byte_count: 5 });
        api.compileWrapped.mockResolvedValue({ hex_string: '00 00 00 00 00', total_length: 5, warnings: [] });
        api.sendTransaction.mockResolvedValue(OK_RECORD);
    });

    const selectHeartbeat = async () => {
        fireEvent.click(await sidebar().findByText('心跳指令'));
    };

    it('#1 TIME 字段显示 [TIME_PICKER] 而非 [READ_ONLY]（编辑形式仍为日期选择器）', async () => {
        renderPage();
        await selectHeartbeat();

        await screen.findByText('[TIME_PICKER]');
        expect(screen.queryByText('[READ_ONLY]')).toBeNull();
    });

    it('#2 点击字段 → BYTE_STREAM_OUTPUT 高亮对应字节 + 读数条（字段名 · 偏移 · 长度）', async () => {
        renderPage();
        await selectHeartbeat();
        await screen.findByText('BYTE_STREAM_OUTPUT');

        // 运行秒数 = 第 2 字段（1 字节命令字之后 4 字节）→ @0x01-0x04
        fireEvent.click(screen.getByText('运行秒数'));

        const readout = screen.getByTestId('byte-readout');
        expect(readout.textContent).toContain('运行秒数');
        expect(readout.textContent).toContain('0x01-0x04');

        const selected = document.querySelector('[data-byte-segment][data-selected]');
        expect(selected).toBeTruthy();
        expect(selected.getAttribute('data-field-id')).toBe('h2');
        // 段内逐字节 XX XX 分隔（与整帧格式一致，不连写）
        expect(selected.textContent).toBe('00 00 00 00');

        // 未选中段不带 selected 标记
        expect(document.querySelectorAll('[data-byte-segment]').length).toBeGreaterThan(1);
        expect(document.querySelectorAll('[data-byte-segment][data-selected]').length).toBe(1);
    });

    it('#4 定长 hex 字段：徽标 n/N BYTES，超长输入被截断（2 字符 = 1 字节）', async () => {
        renderPage();
        await selectHeartbeat();

        await screen.findByText('1/1 BYTES');
        const input = screen.getByDisplayValue('00');
        fireEvent.change(input, { target: { value: 'AA BB' } });
        expect(input.value).toBe('AA');
    });

    it('#2 修复：嵌套组内点叶字段 → 只高亮该字段自身字节（不被冒泡升成整块）', async () => {
        renderPage();
        fireEvent.click(await sidebar().findByText('嵌套指令'));
        await screen.findByText('BYTE_STREAM_OUTPUT');

        // 段尾 = 内组叶字段，1 字节 @0x01（当前 bug：冒泡到组容器 → 整组高亮）
        fireEvent.click(screen.getByText('段尾'));

        const readout = screen.getByTestId('byte-readout');
        expect(readout.textContent).toContain('段尾');
        expect(readout.textContent).toContain('0x01-0x01');
        expect(readout.textContent).not.toContain('头组');
        expect(readout.textContent).not.toContain('内组');

        const selected = document.querySelectorAll('[data-byte-segment][data-selected]');
        expect(selected.length).toBe(1);
        expect(selected[0].getAttribute('data-field-id')).toBe('n2');
        expect(selected[0].textContent).toBe('00');
    });

    it('#2 修复：点击内组头 → 选中内组整块，不被外层头组覆盖', async () => {
        renderPage();
        fireEvent.click(await sidebar().findByText('嵌套指令'));
        await screen.findByText('BYTE_STREAM_OUTPUT');

        fireEvent.click(screen.getByText('内组'));

        const readout = screen.getByTestId('byte-readout');
        expect(readout.textContent).toContain('内组');
        expect(readout.textContent).not.toContain('头组');
        expect(readout.textContent).toContain('0x00-0x00'); // 段头
        expect(readout.textContent).toContain('0x01-0x01'); // 段尾
        expect(readout.textContent).toContain('2B');

        const selected = document.querySelectorAll('[data-byte-segment][data-selected]');
        expect(selected.length).toBe(2);
    });
});

// 批 1：字段级十进制录入（定义侧 parameter_config.input_base='dec'）。
describe('批 1：字段级十进制录入', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        api.getResponseSpec.mockRejectedValue(
            Object.assign(new Error('nf'), { response: { status: 404 } })
        );
        api.getOperatorTemplates.mockResolvedValue([]);
        api.getRecipes.mockResolvedValue([]);
        api.getBindings.mockResolvedValue([]);
        api.dispatchPayload.mockResolvedValue({ id: 1, status: 'SENT', byte_count: 2 });
        api.compileWrapped.mockResolvedValue({ hex_string: '00 00', total_length: 2, warnings: [] });
        api.sendTransaction.mockResolvedValue(OK_RECORD);
    });

    it('input_base=dec 字段走十进制通道：显示十进制原值、无 hex 补零、徽标 [1B]', async () => {
        renderPage();
        fireEvent.click(await sidebar().findByText('十进制指令'));
        await screen.findByText('BYTE_STREAM_OUTPUT');

        // 2 字节 dec 字段：无输入态显示 placeholder「0..65535」（第 14 单：占位即域），
        // 不显示 0000 这类 hex 占位
        expect(screen.getByPlaceholderText('0..65535'));
        expect(screen.queryByPlaceholderText('0000')).toBeNull();
        expect(screen.getByText('[2B]')).toBeTruthy(); // 非 hex 通道徽标 = 字节上限

        // 缺省字段仍走 hex 通道（存量对照组）
        expect(screen.getByPlaceholderText('00')).toBeTruthy();
        expect(screen.getByText('1/1 BYTES')).toBeTruthy(); // hex 通道 = 已用/上限
    });

    it('十进制录入 → BYTE_STREAM_OUTPUT 字节正确（值存储恒数值，编码口径不变）', async () => {
        renderPage();
        fireEvent.click(await sidebar().findByText('十进制指令'));
        await screen.findByText('BYTE_STREAM_OUTPUT');

        // 录入 258 = 0x0102 → 字节流 01 02（hex 通道下「258」是非法字符会被清空）
        fireEvent.change(screen.getByPlaceholderText('0..65535'), { target: { value: '258' } });

        await waitFor(() => {
            const segs = [...document.querySelectorAll('[data-byte-segment]')].map(s => s.textContent);
            expect(segs.join(' ')).toBe('01 02 00');
        });
    });

    it('十进制通道数值域钳制：2 字节上限 65535（超出即时钳制，字节流随之更新）', async () => {
        renderPage();
        fireEvent.click(await sidebar().findByText('十进制指令'));
        await screen.findByText('BYTE_STREAM_OUTPUT');

        const speed = screen.getByPlaceholderText('0..65535');
        fireEvent.change(speed, { target: { value: '99999' } });
        expect(speed.value).toBe('65535');

        await waitFor(() => {
            const segs = [...document.querySelectorAll('[data-byte-segment]')].map(s => s.textContent);
            expect(segs.join(' ')).toBe('FF FF 00');
        });
    });
});

// 批 3：加工侧 BITFIELD 按子位录入（与整包 hex 输入并存，单一真源=字段整数）。
describe('批 3：BITFIELD 按子位录入', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        api.getResponseSpec.mockRejectedValue(
            Object.assign(new Error('nf'), { response: { status: 404 } })
        );
        api.getOperatorTemplates.mockResolvedValue([]);
        api.getRecipes.mockResolvedValue([]);
        api.getBindings.mockResolvedValue([]);
        api.dispatchPayload.mockResolvedValue({ id: 1, status: 'SENT', byte_count: 1 });
        api.compileWrapped.mockResolvedValue({ hex_string: '05', total_length: 1, warnings: [] });
        api.sendTransaction.mockResolvedValue(OK_RECORD);
    });

    const segRow = (name) => screen.getByText(name).closest('[data-bit-seg]');

    it('子位行与整包输入并存：整包显示打包默认值 05，子位回显 MODE=1 / EN=1', async () => {
        renderPage();
        fireEvent.click(await sidebar().findByText('位域指令'));
        await screen.findByText('BYTE_STREAM_OUTPUT');

        expect(screen.getByDisplayValue('05')).toBeTruthy(); // 整包 hex 输入仍在
        expect(segRow('MODE').querySelector('input').value).toBe('1');
        expect(segRow('EN').querySelector('input').value).toBe('1');
    });

    it('改子位 → 整包值与字节流同步（MODE=2 → 0x06）', async () => {
        renderPage();
        fireEvent.click(await sidebar().findByText('位域指令'));
        await screen.findByText('BYTE_STREAM_OUTPUT');

        fireEvent.change(segRow('MODE').querySelector('input'), { target: { value: '2' } });

        await waitFor(() => expect(screen.getByDisplayValue('06')).toBeTruthy());
        await waitFor(() => {
            expect([...document.querySelectorAll('[data-byte-segment]')].map(s => s.textContent).join(' ')).toBe('06');
        });
    });

    it('整包改值 → 子位反向重算（0F → MODE=3 / EN=1）', async () => {
        renderPage();
        fireEvent.click(await sidebar().findByText('位域指令'));
        await screen.findByText('BYTE_STREAM_OUTPUT');

        fireEvent.change(screen.getByDisplayValue('05'), { target: { value: '0F' } });

        await waitFor(() => expect(segRow('MODE').querySelector('input').value).toBe('3'));
        expect(segRow('EN').querySelector('input').value).toBe('1');
    });

    it('子位回写保留无主位（间隙 bit3..7）：整包 0F 后改 MODE=1 → 0D', async () => {
        renderPage();
        fireEvent.click(await sidebar().findByText('位域指令'));
        await screen.findByText('BYTE_STREAM_OUTPUT');

        fireEvent.change(screen.getByDisplayValue('05'), { target: { value: '0F' } });
        await waitFor(() => expect(segRow('MODE').querySelector('input').value).toBe('3'));

        fireEvent.change(segRow('MODE').querySelector('input'), { target: { value: '1' } });
        await waitFor(() => expect(screen.getByDisplayValue('0D')).toBeTruthy());
    });
});

// CP3 3a (D13): 降级链三级（配方 → 默认协议 → 裸发）+ 加工页分层堆叠预览 + 失效徽标。
// 三层帧主向量单一真相源 = vectors/wrap.json · 表 three（三处同读，改一必改三）。
describe('CP3 3a 加工页降级链与分层预览', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        api.getResponseSpec.mockRejectedValue(
            Object.assign(new Error('nf'), { response: { status: 404 } })
        );
        api.getOperatorTemplates.mockResolvedValue([]);
        api.getRecipes.mockResolvedValue([]);
        api.getBindings.mockResolvedValue([]);
        api.dispatchPayload.mockResolvedValue({ id: 1, status: 'SENT', byte_count: 11 });
        api.compileWrapped.mockResolvedValue(recipeCompileResult());
        api.sendTransaction.mockResolvedValue(OK_RECORD);
    });

    it('第 1 级命中：配方 → RECIPE ACTIVE、编译只给 recipeId、分层堆叠渲染向量三层', async () => {
        api.getRecipes.mockResolvedValue([RECIPE]);
        renderPage();
        await selectInstruction();

        // 降级链第 1 级优先，且按 instruction_id 反查
        await screen.findByText(/RECIPE ACTIVE/);
        expect(screen.getByTestId('wrap-status').textContent)
            .toContain('RECIPE ACTIVE // 三层配方 · 3 层');
        expect(api.getRecipes).toHaveBeenCalledWith('inst-1');

        // 编译只带 recipeId（槽位归配方阶段所有），响应 stages 驱动分层堆叠
        await waitFor(() => expect(api.compileWrapped).toHaveBeenCalledTimes(1), { timeout: 2000 });
        expect(api.compileWrapped).toHaveBeenCalledWith({
            recipeId: RECIPE_ID, payloads: ['01']
        });

        await waitFor(() => expect(screen.getByTestId('wrap-layer-2')), { timeout: 2000 });
        expect(screen.getByTestId('wrap-layers')).toBeTruthy();

        // 三层逐行：层号 · 协议 label · 该层 hex · Δ · LEN 卡面真值
        THREE.expect.stages.forEach((stage, i) => {
            const row = screen.getByTestId(`wrap-layer-${i}`);
            expect(row.textContent).toContain(`L${i + 1}`);
            expect(row.textContent).toContain(THREE.layers[i].label);
            expect(row.textContent).toContain(`Δ+${stage.delta_bytes}B`);
            expect(row.textContent).toContain(`${stage.total_length}B`);
            expect(row.textContent).toContain(`LEN ${stage.logic[0].label}=${stage.logic[0].value}`);
            expect(screen.getByText(stage.hex)).toBeTruthy();
        });
        // 最后一层 hex = 最终帧（与后端 / compile / dispatch 同一份实现同字节）
        expect(screen.getByText(THREE.expect.hex)).toBeTruthy();
        expect(screen.getByText('WRAPPED_LAYERS')).toBeTruthy();
    });

    it('失效徽标：stage.stale → RECIPE STALE 徽标 + 该层告警（warning 不阻断）', async () => {
        api.getRecipes.mockResolvedValue([RECIPE]);
        api.compileWrapped.mockResolvedValue(recipeCompileResult(0));
        renderPage();
        await selectInstruction();

        await waitFor(() => expect(screen.getByTestId('wrap-stale')), { timeout: 2000 });
        expect(screen.getByTestId('wrap-stale').textContent).toContain('配方已失效');
        // 逐层告警挂在出错层；stale 层角标换 DEF STALE
        expect(screen.getByTestId('wrap-layer-0').textContent).toContain('DEF STALE');
        expect(screen.getByTestId('wrap-layer-0').textContent).toContain('配方已失效');
        expect(screen.getByTestId('wrap-layer-1').textContent).not.toContain('DEF STALE');
    });

    it('TRANSMIT 与事务同带 recipe_id（预览 / 发送同参同字节）', async () => {
        api.getRecipes.mockResolvedValue([RECIPE]);
        renderPage();
        await selectInstruction();
        await screen.findByText(/RECIPE ACTIVE/);

        fireEvent.click(screen.getByRole('button', { name: /TRANSMIT_DATA/ }));
        await waitFor(() => expect(api.dispatchPayload).toHaveBeenCalledTimes(1));
        expect(api.dispatchPayload).toHaveBeenCalledWith(
            '01', '开门指令', expect.objectContaining({ mode: 'recipe', recipe_id: RECIPE_ID })
        );

        fireEvent.click(screen.getByRole('button', { name: /SEND_TRANSACTION/ }));
        await waitFor(() => expect(api.sendTransaction).toHaveBeenCalledTimes(1));
        expect(api.sendTransaction.mock.calls[0][0].wrap).toEqual(
            expect.objectContaining({ mode: 'recipe', recipe_id: RECIPE_ID })
        );
        // 事务面板指示配方名与层数（非 protocol_id 形态）
        expect(screen.getByText(/RECIPE 三层配方 · 3 层/)).toBeTruthy();
    });

    it('配方拉取失败 → 不整机降级，继续第 2 级默认协议', async () => {
        api.getRecipes.mockRejectedValue(new Error('backend down'));
        api.getBindings.mockResolvedValue([DEFAULT_ROW]);
        renderPage();
        await selectInstruction();

        await screen.findByText(/WRAP ACTIVE \/\/ p-1/);
        expect(api.getBindings).toHaveBeenCalledWith('inst-1');
        expect(api.getRecipes).toHaveBeenCalledWith('inst-1');
    });

    it('配方 stages 为空（无效配方）→ 落到第 2 级；第 2 级也无 → 裸发', async () => {
        api.getRecipes.mockResolvedValue([{ ...RECIPE, stages: [] }]);
        api.getBindings.mockResolvedValue([DEFAULT_ROW]);
        renderPage();
        await selectInstruction();

        await screen.findByText(/WRAP ACTIVE \/\/ p-1/);

        // 第 2 级也没有默认行 → 第 3 级裸发（开关禁用）
        api.getRecipes.mockResolvedValue([]);
        api.getBindings.mockResolvedValue([]);
        fireEvent.click(await sidebar().findByText('关门指令'));
        await screen.findByText(/NO DEFAULT BINDING/);
        expect(screen.getByRole('button', { name: /WRAP ○/ }).disabled).toBe(true);
    });
});

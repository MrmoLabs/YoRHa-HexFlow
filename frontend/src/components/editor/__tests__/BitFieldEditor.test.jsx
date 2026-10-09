import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import BitFieldEditor from '../BitFieldEditor';

// 批 2：位域布局可视化 —— 位网格 + 点击式设段，与下方数值表格双向同步。
// R68 连续位带拼图条：默认视图改为一条连续位带（msb 在左、可切视角），
// 旧 byte×8 网格降为切换副视图（data-view-btn="grid"）；网格类测试经
// showGrid() 前置切换（守卫：按钮在场才点 → 实现前基线跑，红证据只来自新特性）。

const BITS = [
    { id: 'a', bit_name: 'MODE', start_bit: 0, bit_len: 2, default_val: 1 }
];

const cellOf = (bitIndex) => document.querySelector(`[data-bit-cell="${bitIndex}"]`);

const showGrid = () => {
    const btn = document.querySelector('[data-view-btn="grid"]');
    if (btn) fireEvent.click(btn);
};

describe('BitFieldEditor 位图可视化（批 2）', () => {
    it('渲染 byte_len × 8 位网格（bit0 在最右）', () => {
        render(<BitFieldEditor bits={[]} byteLen={2} onUpdateBits={vi.fn()} />);
        showGrid();

        expect(document.querySelectorAll('[data-byte-row]')).toHaveLength(2);
        expect(document.querySelectorAll('[data-bit-cell]')).toHaveLength(16);
        // 第 0 行左端是 bit7（MSB），右端是 bit0（LSB）
        expect(cellOf(7)).toBeTruthy();
        expect(cellOf(0)).toBeTruthy();
    });

    it('已有位段在网格上着色归属（title 回显位名与位域）', () => {
        render(<BitFieldEditor bits={BITS} byteLen={1} onUpdateBits={vi.fn()} />);
        showGrid();

        const ownerCell = cellOf(0); // MODE 占 bit0..bit1
        expect(ownerCell.getAttribute('data-owner')).toBe('0');
        expect(ownerCell.getAttribute('title')).toContain('MODE');
        expect(cellOf(2).getAttribute('data-owner')).toBeNull();
    });

    it('点击式设段：点起始格 → 点终止格 → 提交新位段（写入 onUpdateBits）', () => {
        const onUpdateBits = vi.fn();
        render(<BitFieldEditor bits={[]} byteLen={1} onUpdateBits={onUpdateBits} />);
        showGrid();

        fireEvent.click(cellOf(4));
        // 已上膛：等待终点（不提交）
        expect(onUpdateBits).not.toHaveBeenCalled();
        expect(document.querySelector('[data-bit-arm]')).toBeTruthy();

        fireEvent.click(cellOf(7));
        expect(onUpdateBits).toHaveBeenCalledTimes(1);
        const next = onUpdateBits.mock.calls[0][0];
        expect(next).toHaveLength(1);
        expect(next[0]).toMatchObject({ start_bit: 4, bit_len: 4, bit_name: 'BIT_4', default_val: 0 });
        expect(next[0].id).toBeTruthy(); // 有稳定 id，表格可编辑
    });

    it('设段方向无关（点高格再点低格）+ 同格 = 1 位段', () => {
        const onUpdateBits = vi.fn();
        const { unmount } = render(<BitFieldEditor bits={[]} byteLen={1} onUpdateBits={onUpdateBits} />);
        showGrid();
        fireEvent.click(cellOf(6));
        fireEvent.click(cellOf(5));
        expect(onUpdateBits.mock.calls[0][0][0]).toMatchObject({ start_bit: 5, bit_len: 2 });
        unmount();

        const spy = vi.fn();
        render(<BitFieldEditor bits={[]} byteLen={1} onUpdateBits={spy} />);
        showGrid();
        fireEvent.click(cellOf(1));
        fireEvent.click(cellOf(1));
        expect(spy.mock.calls[0][0][0]).toMatchObject({ start_bit: 1, bit_len: 1 });
    });

    it('点已有位段的格子 = 选中该段（表格行高亮同步），不上膛', () => {
        render(<BitFieldEditor bits={BITS} byteLen={1} onUpdateBits={vi.fn()} />);
        showGrid();

        fireEvent.click(cellOf(0));
        expect(document.querySelector('[data-bit-arm]')).toBeNull();
        const row = document.querySelector('[data-bit-row="0"]');
        expect(row.getAttribute('data-selected')).toBe('true');
    });

    it('表格行点击 → 网格上对应位段同步选中（双向联动）', () => {
        render(<BitFieldEditor bits={BITS} byteLen={1} onUpdateBits={vi.fn()} />);
        showGrid();

        const row = document.querySelector('[data-bit-row="0"]');
        fireEvent.click(within(row).getByDisplayValue('MODE'));
        expect(row.getAttribute('data-selected')).toBe('true');
        expect(cellOf(0).className).toContain('ring-1');
    });

    it('重叠位段：冲突格红标 + 冲突提示行（不静默取一段）', () => {
        render(
            <BitFieldEditor
                bits={[
                    { id: 'a', bit_name: 'A', start_bit: 0, bit_len: 4, default_val: 0 },
                    { id: 'b', bit_name: 'B', start_bit: 2, bit_len: 4, default_val: 0 }
                ]}
                byteLen={1}
                onUpdateBits={vi.fn()}
            />
        );
        showGrid();

        expect(cellOf(2).getAttribute('data-conflict')).toBe('true');
        expect(cellOf(3).getAttribute('data-conflict')).toBe('true');
        expect(screen.getByText(/位范围重叠/)).toBeTruthy();
    });

    it('预览：默认打包值 hex + 所需字节超限告警（溢出段在网格上可见）', () => {
        render(
            <BitFieldEditor
                bits={[{ id: 'a', bit_name: 'W', start_bit: 8, bit_len: 8, default_val: 0x12 }]}
                byteLen={1}
                onUpdateBits={vi.fn()}
            />
        );
        showGrid();

        // 段在 bit8..bit15（高字节）→ 打包值 0x1200（按所需字节 2B 定宽）
        expect(screen.getByText('0x1200')).toBeTruthy();
        expect(screen.getByText(/TOO SMALL/)).toBeTruthy();
        // 溢出段格子仍渲染（byteCount 跟随 requiredBytes）
        expect(cellOf(15)).toBeTruthy();
    });
});

// 优化批 2/3/4（市场调研后优化）：位号标尺（LSb0/MSb0 标注惯例 —— 免得自己数）、
// 有符号切换（DBC signed）、值表编辑与名称回显（DBC VAL_）。
describe('BitFieldEditor 优化批：位号标尺 / 有符号 / 值表', () => {
    it('位号标尺：网格顶部 7..0 列头，先于字节行渲染', () => {
        render(<BitFieldEditor bits={BITS} byteLen={2} onUpdateBits={vi.fn()} />);
        showGrid();

        const ruler = document.querySelector('[data-bit-ruler]');
        expect(ruler).toBeTruthy();
        expect([...ruler.querySelectorAll('[data-bit-ruler-no]')].map(s => s.textContent))
            .toEqual(['7', '6', '5', '4', '3', '2', '1', '0']);
        const firstRow = document.querySelector('[data-byte-row="0"]');
        expect(!!(ruler.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    });

    it('有符号切换：行内 U/S 芯片，点击写回 signed', () => {
        const onUpdateBits = vi.fn();
        const { unmount } = render(<BitFieldEditor bits={BITS} byteLen={1} onUpdateBits={onUpdateBits} />);

        const btn = document.querySelector('[data-bit-signed="0"]');
        expect(btn).toBeTruthy();
        expect(btn.textContent).toBe('U');
        fireEvent.click(btn);
        expect(onUpdateBits.mock.calls[0][0][0].signed).toBe(true);
        unmount();

        render(<BitFieldEditor bits={[{ ...BITS[0], signed: true }]} byteLen={1} onUpdateBits={vi.fn()} />);
        expect(document.querySelector('[data-bit-signed="0"]').textContent).toBe('S');
    });

    it('有符号位段：默认值输入放开负域（两补码域），键入 -40 写回', () => {
        const onUpdateBits = vi.fn();
        render(
            <BitFieldEditor
                bits={[{ id: 'a', bit_name: 'TEMP', start_bit: 0, bit_len: 8, default_val: 0, signed: true }]}
                byteLen={1}
                onUpdateBits={onUpdateBits}
            />
        );

        const input = document.querySelector('[data-bit-default="0"]');
        expect(input.getAttribute('min')).toBe('-128');
        expect(input.getAttribute('max')).toBe('127');
        fireEvent.change(input, { target: { value: '-40' } });
        expect(onUpdateBits.mock.calls[0][0][0].default_val).toBe(-40);
    });

    it('值表编辑：0=关,1:开 文本解析写回 value_table；空串清空', () => {
        // 受控 harness：写回即回显（否则 React 受控回灌让第二次 change 同值不触发）
        const updates = [];
        const Harness = () => {
            const [bts, setBts] = useState(BITS);
            return (
                <BitFieldEditor
                    bits={bts}
                    byteLen={1}
                    onUpdateBits={(next) => { updates.push(next); setBts(next); }}
                />
            );
        };
        render(<Harness />);

        const vt = document.querySelector('[data-bit-vt="0"]');
        expect(vt).toBeTruthy();
        expect(vt.value).toBe(''); // 无值表 → 空（placeholder 提示格式）
        fireEvent.change(vt, { target: { value: '0=关, 1:开' } });
        expect(updates[0][0].value_table).toEqual([
            { value: 0, label: '关' }, { value: 1, label: '开' }
        ]);
        expect(vt.value).toBe('0=关,1=开'); // 回显归一（1:开 → 1=开）

        fireEvent.change(vt, { target: { value: '' } });
        expect(updates[1][0].value_table).toBeUndefined();
        expect(vt.value).toBe('');
    });

    it('值表回显与名称解码：VT 单元格文本、默认值 title、网格 title 带名称', () => {
        render(
            <BitFieldEditor
                bits={[{
                    id: 'a', bit_name: 'MODE', start_bit: 0, bit_len: 2, default_val: 1,
                    value_table: [{ value: 1, label: '开' }]
                }]}
                byteLen={1}
                onUpdateBits={vi.fn()}
            />
        );

        expect(document.querySelector('[data-bit-vt="0"]').value).toBe('1=开');
        expect(document.querySelector('[data-bit-default="0"]').getAttribute('title')).toContain('开');
        showGrid();
        expect(cellOf(0).getAttribute('title')).toContain('开'); // MODE = 1 (开) · bit0
    });
});

// R68：连续位带拼图条 —— 默认主视图。存储口径（start_bit LSB、打包、校验）
// 零触碰，纯展示/交互层；拖拽画段、拖块边改宽、双击内联改名、msb/lsb 视角。
describe('R68 连续位带拼图条（默认视图 = 位带）', () => {
    const gapOf = (bit) => document.querySelector(`[data-strip-gap="${bit}"]`);
    const bitOf = (bit) => document.querySelector(`[data-strip-bit="${bit}"]`);
    const stripEl = () => document.querySelector('[data-strip]');
    const ruler = () => [...document.querySelectorAll('[data-strip-ruler-no]')]
        .map((s) => Number(s.getAttribute('data-strip-ruler-no')));
    // 位带设段状态机走 mousedown/mouseup（真浏览器一次点击即此序列）
    const press = (el) => {
        fireEvent.mouseDown(el);
        fireEvent.mouseUp(stripEl());
    };

    it('默认渲染位带（msb 在左），网格未渲染；视图切换按钮在场', () => {
        render(<BitFieldEditor bits={[]} byteLen={2} onUpdateBits={vi.fn()} />);
        expect(stripEl()).toBeTruthy();
        expect(stripEl().getAttribute('data-strip-view')).toBe('msb');
        expect(document.querySelectorAll('[data-byte-row]')).toHaveLength(0);
        expect(document.querySelector('[data-view-btn="grid"]')).toBeTruthy();
    });

    it('msb 视角 = 高位在左（ruler 15..0）；切 lsb → 0..15', () => {
        render(<BitFieldEditor bits={[]} byteLen={2} onUpdateBits={vi.fn()} />);
        expect(ruler()).toEqual([15, 14, 13, 12, 11, 10, 9, 8,
            7, 6, 5, 4, 3, 2, 1, 0]);
        fireEvent.click(document.querySelector('[data-orient-btn="lsb"]'));
        expect(ruler()).toEqual([0, 1, 2, 3, 4, 5, 6, 7,
            8, 9, 10, 11, 12, 13, 14, 15]);
        expect(stripEl().getAttribute('data-strip-view')).toBe('lsb');
    });

    it('段渲染为带名拼图块：占用位归属、位宽角标、色随段序', () => {
        render(<BitFieldEditor bits={BITS} byteLen={1} onUpdateBits={vi.fn()} />);
        const seg = document.querySelector('[data-strip-seg="0"]');
        expect(seg).toBeTruthy();
        expect(seg.querySelector('[data-strip-label="0"]').textContent)
            .toContain('MODE');
        expect(seg.querySelector('[data-strip-label="0"]').textContent)
            .toContain('2');
        // msb 视角：MODE(bit0..1) 在带右端，bit1 左、bit0 右；bit7 是缺块
        expect(seg.contains(bitOf(1))).toBe(true);
        expect(seg.contains(bitOf(0))).toBe(true);
        expect(seg.contains(bitOf(7))).toBe(false);
        expect(seg.querySelector('[data-strip-bit]').style.backgroundColor).toBeTruthy();
        expect(seg.getAttribute('data-conflict')).toBeNull();
    });

    it('间隙 = 逐位缺块，msb 序在场（段占位后缺口正确）', () => {
        render(<BitFieldEditor bits={BITS} byteLen={1} onUpdateBits={vi.fn()} />);
        const gaps = [...document.querySelectorAll('[data-strip-gap]')]
            .map((g) => Number(g.getAttribute('data-strip-gap')));
        expect(gaps).toEqual([7, 6, 5, 4, 3, 2]); // MODE 占 bit0..1
    });

    it('两下设段（迁移口径）：点缺块上膛 → 点第二格提交', () => {
        const onUpdateBits = vi.fn();
        render(<BitFieldEditor bits={[]} byteLen={1} onUpdateBits={onUpdateBits} />);
        press(gapOf(4));
        expect(onUpdateBits).not.toHaveBeenCalled();
        expect(document.querySelector('[data-strip-arm="4"]')).toBeTruthy();
        press(gapOf(7));
        expect(onUpdateBits).toHaveBeenCalledTimes(1);
        expect(onUpdateBits.mock.calls[0][0][0]).toMatchObject({
            start_bit: 4, bit_len: 4, bit_name: 'BIT_4'
        });
    });

    it('同格两次 = 1 位段；设段方向无关（先高后低）', () => {
        const onUpdateBits = vi.fn();
        const { unmount } = render(
            <BitFieldEditor bits={[]} byteLen={1} onUpdateBits={onUpdateBits} />
        );
        press(gapOf(6));
        press(gapOf(2));
        expect(onUpdateBits.mock.calls[0][0][0]).toMatchObject({
            start_bit: 2, bit_len: 5
        });
        unmount();

        const spy = vi.fn();
        render(<BitFieldEditor bits={[]} byteLen={1} onUpdateBits={spy} />);
        press(gapOf(3));
        press(gapOf(3));
        expect(spy.mock.calls[0][0][0]).toMatchObject({
            start_bit: 3, bit_len: 1
        });
    });

    it('拖拽画段：mousedown 缺块 → 悬停另一缺块 → 松开提交区间', () => {
        const onUpdateBits = vi.fn();
        render(<BitFieldEditor bits={[]} byteLen={1} onUpdateBits={onUpdateBits} />);
        fireEvent.mouseDown(gapOf(5));
        fireEvent.mouseOver(gapOf(2));
        fireEvent.mouseUp(stripEl());
        expect(onUpdateBits).toHaveBeenCalledTimes(1);
        expect(onUpdateBits.mock.calls[0][0][0]).toMatchObject({
            start_bit: 2, bit_len: 4
        });
    });

    it('起手未拖（同格 mousedown/mouseup）= 保持上膛不提交', () => {
        const onUpdateBits = vi.fn();
        render(<BitFieldEditor bits={[]} byteLen={1} onUpdateBits={onUpdateBits} />);
        fireEvent.mouseDown(gapOf(6));
        fireEvent.mouseUp(stripEl());
        expect(onUpdateBits).not.toHaveBeenCalled();
        expect(document.querySelector('[data-strip-arm="6"]')).toBeTruthy();
    });

    it('拖块边改宽：拖 end 边（高位侧）到高位缺块 → 位宽扩展', () => {
        const onUpdateBits = vi.fn();
        render(<BitFieldEditor bits={BITS} byteLen={1} onUpdateBits={onUpdateBits} />);
        // MODE(bit0..1) msb 视角在带右端；end 边（bit1 侧）朝左邻 bit2 缺块
        const edge = document.querySelector('[data-strip-edge="end"]');
        expect(edge).toBeTruthy();
        fireEvent.mouseDown(edge);
        fireEvent.mouseOver(gapOf(3));
        fireEvent.mouseUp(stripEl());
        expect(onUpdateBits).toHaveBeenCalledTimes(1);
        expect(onUpdateBits.mock.calls[0][0][0]).toMatchObject({
            start_bit: 0, bit_len: 4
        });
    });

    it('拖 start 边（低位侧）收缩 → 起点右移、终点不动', () => {
        const onUpdateBits = vi.fn();
        const four = [{
            id: 'f', bit_name: 'FOUR', start_bit: 0, bit_len: 4, default_val: 0
        }];
        render(<BitFieldEditor bits={four} byteLen={1} onUpdateBits={onUpdateBits} />);
        const edge = document.querySelector('[data-strip-edge="start"]');
        fireEvent.mouseDown(edge);
        fireEvent.mouseOver(bitOf(2)); // 段内位（收缩越过自身格）
        fireEvent.mouseUp(stripEl());
        expect(onUpdateBits).toHaveBeenCalledTimes(1);
        expect(onUpdateBits.mock.calls[0][0][0]).toMatchObject({
            start_bit: 2, bit_len: 2
        });
    });

    it('双击段名内联改名 → 写回 bit_name', () => {
        const onUpdateBits = vi.fn();
        render(<BitFieldEditor bits={BITS} byteLen={1} onUpdateBits={onUpdateBits} />);
        fireEvent.dblClick(document.querySelector('[data-strip-label="0"]'));
        const input = document.querySelector('[data-strip-rename="0"]');
        expect(input).toBeTruthy();
        fireEvent.change(input, { target: { value: 'VER' } });
        expect(onUpdateBits).toHaveBeenCalledWith([
            expect.objectContaining({ bit_name: 'VER' })
        ]);
    });

    it('点段选中 ↔ 表格行双向联动（位带与表格同频）', () => {
        render(<BitFieldEditor bits={BITS} byteLen={1} onUpdateBits={vi.fn()} />);
        fireEvent.click(document.querySelector('[data-strip-seg="0"]'));
        expect(document.querySelector('[data-bit-row="0"]')
            .getAttribute('data-selected')).toBe('true');
        // 反向：点表格行输入框 → 段标选中
        const row = document.querySelector('[data-bit-row="0"]');
        fireEvent.click(within(row).getByDisplayValue('MODE'));
        expect(document.querySelector('[data-strip-seg="0"]')
            .getAttribute('data-strip-selected')).toBe('true');
    });

    it('重叠段红标：段级 conflict 双标 + 冲突提示行', () => {
        render(
            <BitFieldEditor
                bits={[
                    { id: 'a', bit_name: 'A', start_bit: 0, bit_len: 4, default_val: 0 },
                    { id: 'b', bit_name: 'B', start_bit: 2, bit_len: 4, default_val: 0 }
                ]}
                byteLen={1}
                onUpdateBits={vi.fn()}
            />
        );
        const segs = document.querySelectorAll('[data-strip-seg]');
        expect(segs).toHaveLength(2);
        expect(segs[0].getAttribute('data-conflict')).toBe('true');
        expect(segs[1].getAttribute('data-conflict')).toBe('true');
        expect(screen.getByText(/位范围重叠/)).toBeTruthy();
    });

    it('字节边界线：byteLen 3 → 2 条，msb/lsb 百分比镜像', () => {
        const { unmount } = render(
            <BitFieldEditor bits={[]} byteLen={3} onUpdateBits={vi.fn()} />
        );
        const pcts = () => [...document.querySelectorAll('[data-strip-byte]')]
            .map((b) => parseFloat(b.style.left));
        expect(pcts()).toHaveLength(2);
        expect(pcts()[0]).toBeCloseTo((24 - 8) / 24 * 100, 5);
        expect(pcts()[1]).toBeCloseTo((24 - 16) / 24 * 100, 5);
        unmount();
        render(<BitFieldEditor bits={[]} byteLen={3} onUpdateBits={vi.fn()} />);
        fireEvent.click(document.querySelector('[data-orient-btn="lsb"]'));
        const l = [...document.querySelectorAll('[data-strip-byte]')]
            .map((b) => parseFloat(b.style.left));
        expect(l[0]).toBeCloseTo(8 / 24 * 100, 5);
        expect(l[1]).toBeCloseTo(16 / 24 * 100, 5);
    });

    it('切网格视图：旧 byte×8 网格原样可用，位带卸载（迁移面保留）', () => {
        render(<BitFieldEditor bits={[]} byteLen={2} onUpdateBits={vi.fn()} />);
        expect(document.querySelectorAll('[data-byte-row]')).toHaveLength(0);
        fireEvent.click(document.querySelector('[data-view-btn="grid"]'));
        expect(document.querySelectorAll('[data-byte-row]')).toHaveLength(2);
        expect(document.querySelectorAll('[data-bit-cell]')).toHaveLength(16);
        expect(stripEl()).toBeNull();
    });

    it('溢出位段：位带容量跟随所需字节撑开 + TOO SMALL 提示', () => {
        render(
            <BitFieldEditor
                bits={[{ id: 'h', bit_name: 'HIGH', start_bit: 12, bit_len: 4 }]}
                byteLen={1}
                onUpdateBits={vi.fn()}
            />
        );
        expect(ruler()).toHaveLength(16);
        expect(bitOf(15)).toBeTruthy();
        expect(screen.getByText(/TOO SMALL/)).toBeTruthy();
    });
});

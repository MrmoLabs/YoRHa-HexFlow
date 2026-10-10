import { describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import Block from '../Block';

const renderBlock = (props) =>
    render(
        <DndContext>
            <Block id="b1" {...props} />
        </DndContext>
    );

// Card root: Block sets `id="block-b1"` on its root div.
const cardOf = (container) => container.querySelector('#block-b1');
// Center value container (unique `flex-1` class on the byte indicator div).
const centerOf = (container) => container.querySelector('.flex-1');
const offsetSpanOf = (container) => container.querySelector('[title^="字节偏移"]');

describe('Block (P1 offset ruler + smart width)', () => {
    it('group card: center shows per-byte unknowns when content is un-injected, footer shows Σ bytes before offset, width follows Σ extent', () => {
        const { container } = renderBlock({
            name: '状态块',
            op_code: 'ARRAY_GROUP',
            byte_len: 0,
            offsetMeta: { offset: 2, size: 4, isGroup: true },
        });

        // 内容未注入 → 中央 = 按尺寸的等量 ??（未知出等量 ?；页脚仍显尺寸 4B）
        expect(centerOf(container).textContent).toBe('?? ?? ?? ??');

        // Order: bytes (`4B`) come before the offset badge (`@02..`)
        const offsetSpan = offsetSpanOf(container);
        expect(offsetSpan).toBeTruthy();
        expect(offsetSpan.textContent).toBe('@02..');
        expect(offsetSpan.previousElementSibling.textContent).toBe('4B');

        // Σ-driven width: 4B × 40px
        expect(cardOf(container).style.width).toBe('160px');
    });

    it('group card without the ruler shows the lanes-injected nested content string', () => {
        const { container } = renderBlock({
            name: '状态块',
            op_code: 'ARRAY_GROUP',
            parameter_config: { computedValue: 'AA 55 ?? ??' },
        });

        expect(centerOf(container).textContent).toBe('AA 55 ?? ??');
        expect(offsetSpanOf(container)).toBeNull();
    });

    it('unknown group size still shows ?? and widens enough to fit `??B @02..`', () => {
        const { container } = renderBlock({
            name: '组',
            op_code: 'ARRAY_GROUP',
            byte_len: 0,
            offsetMeta: { offset: 2, size: null, isGroup: true },
        });

        expect(centerOf(container).textContent).toBe('??');
        expect(screen.getByText('??B')).toBeTruthy();
        // content floor: ceil(9 chars × 5.4) + 20 = 69px > legacy 60px floor
        expect(parseInt(cardOf(container).style.width, 10)).toBeGreaterThanOrEqual(66);
    });

    it('leaf cards keep byte-driven width, 60px floor, and bytes-before-offset footer', () => {
        const twoByte = renderBlock({
            name: '帧头',
            op_code: 'HEX_RAW',
            byte_len: 2,
            offsetMeta: { offset: 0, size: 2 },
        });
        expect(cardOf(twoByte.container).style.width).toBe('80px');
        const offsetSpan = offsetSpanOf(twoByte.container);
        expect(offsetSpan.textContent).toBe('@00');
        expect(offsetSpan.previousElementSibling.textContent).toBe('2B');

        // Isolate the second render (duplicate block id in one document).
        cleanup();
        const oneByte = renderBlock({
            name: '帧尾',
            op_code: 'HEX_RAW',
            byte_len: 1,
            offsetMeta: { offset: 7, size: 1 },
        });
        // content floor for `1B @07` (6ch × 5.4 + 20 ≈ 53) stays under the 60px floor
        expect(cardOf(oneByte.container).style.width).toBe('60px');
    });

    it('long names render single-line complete: label width floor overrides the byte width', () => {
        const { container } = renderBlock({
            name: '长度计算_原始数据块副本',
            op_code: 'HEX_RAW',
            byte_len: 1,
            offsetMeta: { offset: 0, size: 1 },
        });

        const label = container.querySelector('#block-b1 span');
        expect(label.className).toContain('whitespace-nowrap'); // 不换行
        expect(label.parentElement.className).not.toContain('text-ellipsis'); // 不截断

        // 11 CJK + `_`: ceil(11×11.5 + 8 + 6) = 141 → +20 = 161px ≥ 150，
        // 宽度地板被标签撑开，覆盖单行完整显示（byte_len=1 本为 60px）。
        expect(parseInt(cardOf(container).style.width, 10)).toBeGreaterThanOrEqual(150);
    });

    // ─── 卡面取值口径：能确定 → 直接显示；不确定 → 按字节数出等量 ?? ───────
    it('length / checksum cards show per-byte unknowns (2B → "?? ??", not a single ??)', () => {
        const twoByteLen = renderBlock({
            name: '长度', type: 'length', byte_length: 2,
            offsetMeta: { offset: 0, size: 2 },
        });
        expect(centerOf(twoByteLen.container).textContent).toBe('?? ??');

        cleanup();
        const oneByteCrc = renderBlock({
            name: '校验', type: 'checksum', byte_length: 1,
            offsetMeta: { offset: 2, size: 1 },
        });
        expect(centerOf(oneByteCrc.container).textContent).toBe('??');
    });

    it('TIME_ACCUMULATOR renders a BASE line under the center value (configured / unconfigured)', () => {
        const { container } = renderBlock({
            name: '基准时间', op_code: 'TIME_ACCUMULATOR', byte_len: 4,
            parameter_config: { base_time: '2026-09-23T14:00:00Z' },
            offsetMeta: { offset: 0, size: 4 },
        });
        // ISO T 分隔与秒位剥除 → YYYY-MM-DD HH:mm
        expect(container.textContent).toContain('BASE 2026-09-23 14:00');

        cleanup();
        const unconfigured = renderBlock({
            name: '基准时间', op_code: 'TIME_ACCUMULATOR', byte_len: 4,
            offsetMeta: { offset: 0, size: 4 },
        });
        expect(unconfigured.container.textContent).toContain('BASE ?');
    });

    // ─── 人工验证第 3 轮 #2: 卡面显示口径（?? 仅限无法确定内容的卡） ─────────
    it('fixed card: real hex renders as stored value; all-zero default hex also renders its stored value', () => {
        const real = renderBlock({
            name: '帧头', type: 'fixed', hex_value: 'DE AD', byte_length: 2,
            offsetMeta: { offset: 0, size: 2 },
        });
        expect(centerOf(real.container).textContent).toBe('DE AD');

        cleanup();
        const zeroTwo = renderBlock({
            name: '固定块', type: 'fixed', hex_value: '0000', byte_length: 2,
            offsetMeta: { offset: 0, size: 2 },
        });
        expect(centerOf(zeroTwo.container).textContent).toBe('00 00'); // 未配置固定块 = 显示存储值

        cleanup();
        const zeroOne = renderBlock({
            name: '固定块', type: 'fixed', hex_value: '00', byte_length: 1,
            offsetMeta: { offset: 2, size: 1 },
        });
        expect(centerOf(zeroOne.container).textContent).toBe('00');

        cleanup();
        const mixed = renderBlock({
            name: '固定块', type: 'fixed', hex_value: '0A 00', byte_length: 2,
            offsetMeta: { offset: 0, size: 2 },
        });
        expect(centerOf(mixed.container).textContent).toBe('0A 00'); // 非全 0 真值照常直填
    });

    it('fixed card without any hex shows per-byte ?? (still undeterminable), never a fake "00"', () => {
        const { container } = renderBlock({
            name: '固定块', type: 'fixed', byte_length: 1,
            offsetMeta: { offset: 0, size: 1 },
        });
        expect(centerOf(container).textContent).toBe('??');
    });

    it('empty container card shows a blank center (not ??, not "0B"), footer keeps the size', () => {
        const { container } = renderBlock({
            name: '新容器', type: 'container', byte_length: 0,
            offsetMeta: { offset: 0, size: 0, isGroup: true },
        });
        expect(centerOf(container).textContent).toBe('');
        expect(container.textContent).toContain('0B'); // 页脚尺寸口径不变（0B @00）
    });
});

// ─── 验证反馈批次：属性面板提醒 → 卡片标色（边框变色 + header 角标） ─────
// 颜色断言兼容 hex / rgb 两种序列化（jsdom cssstyle 版本差异）。
const normColor = (v) => (v || '').replace(/\s/g, '').toLowerCase();

describe('Block 验证标色（issue prop）', () => {
    it('error 级：非选中卡内联边框红 + header 角标 ⛔（title 带消息）', () => {
        const { container } = renderBlock({
            name: '位域', type: 'bitfield', byte_length: 1,
            issue: { level: 'error', messages: ['「位域」位域重叠（MODE 起始 0 < 上一块结束 2）'] },
        });
        expect(['#d94834', 'rgb(217,72,52)']).toContain(normColor(cardOf(container).style.borderColor));

        const chip = container.querySelector('[data-issue-chip]');
        expect(chip).toBeTruthy();
        expect(chip.getAttribute('data-issue-chip')).toBe('error');
        expect(chip.textContent).toBe('⛔');
        expect(chip.getAttribute('title')).toContain('位域重叠');
    });

    it('warning 级：边框琥珀 + 角标 ⚠', () => {
        const { container } = renderBlock({
            name: '载荷', type: 'fixed', byte_length: 1,
            issue: { level: 'warning', messages: ['「载荷」HEX 值为空'] },
        });
        expect(['#e58d28', 'rgb(229,141,40)']).toContain(normColor(cardOf(container).style.borderColor));
        const chip = container.querySelector('[data-issue-chip]');
        expect(chip.getAttribute('data-issue-chip')).toBe('warning');
        expect(chip.textContent).toBe('⚠');
    });

    it('选中态保 3px 亮边（内联色让位），角标不丢', () => {
        const { container } = renderBlock({
            name: '位域', type: 'bitfield', byte_length: 1,
            isSelected: true,
            issue: { level: 'error', messages: ['坏'] },
        });
        expect(cardOf(container).style.borderColor).toBe(''); // 亮边由 border-nier-light 类承担
        expect(cardOf(container).className).toContain('border-[3px]');
        expect(container.querySelector('[data-issue-chip]')).toBeTruthy();
    });

    it('无 issue → 无角标、无内联边框色（现状不变）', () => {
        const { container } = renderBlock({
            name: '帧头', type: 'fixed', byte_length: 1, hex_value: 'FA',
        });
        expect(container.querySelector('[data-issue-chip]')).toBeNull();
        expect(cardOf(container).style.borderColor).toBe('');
    });
});

describe('Block 文本字段卡面（N2 · G2）', () => {
    it('STRING 卡：中央显原文 value（不再 ?? 占位）', () => {
        const { container } = renderBlock({
            name: '文本', op_code: 'STRING', byte_len: 2,
            parameter_config: { type: 'string', value: 'AB' },
        });
        expect(centerOf(container).textContent).toBe('AB');
    });

    it('存量 INPUT + type=string：中央显 default 原文', () => {
        const { container } = renderBlock({
            name: '页脚', op_code: 'INPUT', byte_len: 2,
            parameter_config: { type: 'string', default: 'HI' },
        });
        expect(centerOf(container).textContent).toBe('HI');
    });

    it('STRING 无静态值 → 按字节出 ?? 占位（现状锁定）', () => {
        const { container } = renderBlock({
            name: '文本', op_code: 'STRING', byte_len: 2,
            parameter_config: { type: 'string' },
        });
        expect(centerOf(container).textContent).toBe('?? ??');
    });

    it('STRING 空串 value → 中央空白（用户清空 = 值为空）', () => {
        const { container } = renderBlock({
            name: '文本', op_code: 'STRING', byte_len: 4,
            parameter_config: { type: 'string', value: '' },
        });
        expect(centerOf(container).textContent).toBe('');
    });
});

// R69：位域卡面 = 泳道式多卡组合（2026-10-09 拍板链四轮定形：初拍二进制化 →
//  「类似容器」二拍段子片 → 真机联调「单卡拥挤」三拍 A 容器盒+独立子卡 →
//  再反馈「不要都塞在一个卡片里，参考泳道但须与 hex 容器泳道区分」终拍 B）：
//  根去卡壳（透明无框）= 名称行 + 泳道头（段数 chip + 总览位带，头内嵌）+
//  泳道体（实线窄带、每段一张独立卡、缺块一张 GAP 卡）；与 hex 容器泳道
//  （border-dashed + 外置标题 + FOCUS）视觉区分（区分契约入测）；值流/图例
//  删除，hex 打包值留页脚小字。纯展示层：packBits 打包口径零触碰。
describe('R69 位域卡泳道式多卡（根去卡壳 + 实线泳道带，区分 hex 容器泳道）', () => {
    const BF_BITS = [
        { id: 'a', bit_name: 'MODE', start_bit: 0, bit_len: 2, default_val: 1 },
        { id: 'b', bit_name: 'VERY_LONG_SEGMENT_NAME_HERE', start_bit: 2, bit_len: 2, default_val: 2 }
    ];
    // packBits: MODE=01 @bit0..1 + LONG=10 @bit2..3 → 0b1001 → '09'

    it('泳道式：根去卡壳（旧封闭盒缺席），泳道头内嵌（段数 chip + 位带），泳道体实线带 ≠ hex 容器泳道虚线', () => {
        const { container } = renderBlock({
            name: '控制', type: 'bitfield', byte_length: 1, bits: BF_BITS,
        });
        const lane = container.querySelector('[data-card-lane]');
        expect(lane).toBeTruthy();
        // 泳道头内嵌：段数 chip（2 段 + 1 缺块 = 3 片）+ 总览位带
        const head = lane.querySelector('[data-card-lane-head]');
        expect(head).toBeTruthy();
        expect(head.textContent).toContain('BITS·3');
        expect(head.querySelector('[data-card-strip]')).toBeTruthy();
        // 终拍 B 区分契约：hex 容器泳道 = border-dashed + 外置标题；本泳道体 =
        // 实线窄带（border-nier-light/25、非 dashed），两者不可混淆
        const body = lane.querySelector('[data-card-lane-body]');
        expect(body).toBeTruthy();
        expect(body.className).toContain('border-nier-light/25');
        expect(body.className).not.toContain('border-dashed');
        // 旧封闭容器盒 / 位域外卡壳不再在场；hex 打包值留页脚小字
        expect(container.querySelector('[data-card-box]')).toBeNull();
        const hexEl = container.querySelector('[data-card-hex]');
        expect(hexEl).toBeTruthy();
        expect(hexEl.textContent).toContain('0x09');
        expect(centerOf(container).textContent).not.toBe('09');
    });

    it('每段一张独立卡（色块 + 段名 + 位宽 + 段 0/1 值），缺块也占一张 GAP 卡', () => {
        const { container } = renderBlock({
            name: '控制', type: 'bitfield', byte_length: 1, bits: BF_BITS,
        });
        const segs = [...container.querySelectorAll('[data-card-seg]')];
        expect(segs).toHaveLength(2);
        // 段值与打包值同源：LONG@bit2..3 = 10、MODE@bit0..1 = 01（msb 视角序）
        const longSeg = segs.find(t => t.textContent.includes('VERY_LONG_SEGMENT_NAME_HERE'));
        const modeSeg = segs.find(t => t.textContent.includes('MODE'));
        expect(longSeg).toBeTruthy();
        expect(longSeg.querySelector('[data-card-seg-val]').textContent).toContain('10');
        expect(longSeg.textContent).toContain('2b');
        expect(longSeg.querySelector('[data-card-seg-chip]').style.backgroundColor).toBeTruthy();
        expect(modeSeg).toBeTruthy();
        expect(modeSeg.querySelector('[data-card-seg-val]').textContent).toContain('01');
        expect(modeSeg.textContent).toContain('2b');
        // 缺块单元（bit4..7 连续一片）也占一张卡，值 = 0000
        const gaps = [...container.querySelectorAll('[data-card-seg-gap]')];
        expect(gaps).toHaveLength(1);
        expect(gaps[0].textContent).toContain('0000');
    });

    it('总览位带（泳道头内）：段按位宽着色在场、间隙 = 缺块、两段色不同（调色板按段序）', () => {
        const { container } = renderBlock({
            name: '控制', type: 'bitfield', byte_length: 1, bits: BF_BITS,
        });
        const strip = container.querySelector('[data-card-strip]');
        expect(strip).toBeTruthy();
        const segs = container.querySelectorAll('[data-card-strip-seg]');
        expect(segs).toHaveLength(2);
        expect(segs[0].style.backgroundColor).toBeTruthy();
        expect(segs[0].style.backgroundColor).not.toBe(segs[1].style.backgroundColor);
        // 未覆盖位 bit4..7 = 缺块（4 位）
        expect(container.querySelectorAll('[data-card-strip-gap]')).toHaveLength(4);
    });

    it('非位域卡不出泳道（既有卡面口径零迁移）', () => {
        const { container } = renderBlock({
            name: 'RAW', type: 'hex', byte_length: 1, hex_value: 'AABB',
        });
        expect(container.querySelector('[data-card-lane]')).toBeNull();
        expect(container.querySelector('[data-card-box]')).toBeNull();
    });

    it('多字节泳道：高字段 W 的段卡值 = 0001 0010（与打包值同源逐位展开）', () => {
        const { container } = renderBlock({
            name: '控制', type: 'bitfield', byte_length: 2,
            bits: [{ id: 'w', bit_name: 'W', start_bit: 8, bit_len: 8, default_val: 0x12 }],
        });
        const segs = [...container.querySelectorAll('[data-card-seg]')];
        const wSeg = segs.find(t => t.textContent.includes('W'));
        expect(wSeg).toBeTruthy();
        expect(wSeg.querySelector('[data-card-seg-val]').textContent).toContain('0001 0010');
        expect(wSeg.textContent).toContain('8b');
    });
});

// R70（§8.102 三 · 自适应位视图）：含 sub-byte/bit 定义帧 → 卡 footer 切 bit 单位
// （偏移尺 bit 刻度：宽 `10b`、偏移 `@b0`、tooltip 标「bit 偏移」）；纯字节帧
// bitView 缺席 → 沿字节口径 `2B @00` 零扰动。
describe('Block（R70 自适应位视图 footer）', () => {
    it('bitView + bitMeta → footer 显 bit 宽/偏移（10b @b0）+ tooltip 标 bit 偏移', () => {
        const { container } = renderBlock({
            name: '主导头', type: 'bitfield', byte_length: 2, bit_len: 10,
            offsetMeta: { offset: 0, size: 2 },
            bitView: true,
            bitMeta: { bitOffset: 0, bitWidth: 10, isContainer: false },
        });
        const offsetSpan = container.querySelector('[title^="bit 偏移"]');
        expect(offsetSpan).toBeTruthy();
        expect(offsetSpan.textContent).toBe('@b0');
        // 前一兄弟 = 宽（bit 口径 10b，非字节口径 2B）
        expect(offsetSpan.previousElementSibling.textContent).toBe('10b');
    });

    it('字节视图（bitView 缺席）footer 沿字节口径 2B @00 零扰动', () => {
        const { container } = renderBlock({
            name: 'RAW', type: 'hex', byte_length: 2, hex_value: 'AABB',
            offsetMeta: { offset: 0, size: 2 },
        });
        const offsetSpan = container.querySelector('[title^="字节偏移"]');
        expect(offsetSpan).toBeTruthy();
        expect(offsetSpan.textContent).toBe('@00');
        expect(offsetSpan.previousElementSibling.textContent).toBe('2B');
    });
});

// R71（§8.102 三 · 值展示）：位域泳道头 BIN⇄HEX 切换 —— 多 bit 段值可切 HEX
// （0x..，与 R69 0b 录入并存），单 bit 旗标与缺块 GAP 恒 bin（spec 三原文）；
// 切换是纯展示动作，不触发卡选中；纯展示层，packBits 打包口径零触碰。
describe('Block（R71 段值 BIN⇄HEX 切换）', () => {
    // 本地夹具（与 R69 BF_BITS 同构）：MODE=01 @bit0..1、LONG=10 @bit2..3、
    // 缺块 bit4..7；packBits → 0x09。
    const BITS = [
        { id: 'a', bit_name: 'MODE', start_bit: 0, bit_len: 2, default_val: 1 },
        { id: 'b', bit_name: 'VERY_LONG_SEGMENT_NAME_HERE', start_bit: 2, bit_len: 2, default_val: 2 }
    ];
    const segValText = (container, name) => {
        const seg = [...container.querySelectorAll('[data-card-seg]')]
            .find(t => t.textContent.includes(name));
        expect(seg).toBeTruthy();
        return seg.querySelector('[data-card-seg-val]').textContent;
    };

    it('泳道头 BIN⇄HEX：多 bit 段值切 0x HEX、缺块 GAP 恒 bin、切换不触发选中', () => {
        const onClick = vi.fn();
        const { container } = renderBlock({
            name: '控制', type: 'bitfield', byte_length: 1, bits: BITS, onClick,
        });
        const toggle = container.querySelector('[data-card-view-toggle]');
        expect(toggle).toBeTruthy();
        expect(toggle.textContent).toBe('BIN');
        // 默认 BIN（msb 视角序：LONG=10、MODE=01）
        expect(segValText(container, 'VERY_LONG')).toContain('10');
        expect(segValText(container, 'MODE')).toContain('01');
        fireEvent.click(toggle);
        // 多 bit 段切 HEX：LONG=0b10→0x2、MODE=0b01→0x1（定宽半字节）
        expect(toggle.textContent).toBe('HEX');
        expect(segValText(container, 'VERY_LONG')).toBe('0x2');
        expect(segValText(container, 'MODE')).toBe('0x1');
        // 缺块 GAP 恒 bin（未覆盖位不承载段值）
        expect(container.querySelector('[data-card-seg-gap]').textContent).toContain('0000');
        // 纯展示动作：点击切换不冒泡到卡选中
        expect(onClick).not.toHaveBeenCalled();
    });

    it('单 bit 旗标在 HEX 档仍显 0/1（spec 三：单 bit 旗标 bin）', () => {
        const { container } = renderBlock({
            name: '主导头', type: 'bitfield', byte_length: 1, bit_len: 4,
            bits: [
                { id: 'f', bit_name: 'FLAG', start_bit: 0, bit_len: 1, default_val: 1 },
                { id: 'v', bit_name: 'VER', start_bit: 1, bit_len: 3, default_val: 5 },
            ],
        });
        fireEvent.click(container.querySelector('[data-card-view-toggle]'));
        expect(segValText(container, 'FLAG')).toBe('1');
        expect(segValText(container, 'VER')).toBe('0x5');
    });

    it('非位域卡不渲染视图切换（既有卡面口径零迁移）', () => {
        const { container } = renderBlock({
            name: 'RAW', type: 'hex', byte_length: 1, hex_value: 'AABB',
        });
        expect(container.querySelector('[data-card-view-toggle]')).toBeNull();
    });
});

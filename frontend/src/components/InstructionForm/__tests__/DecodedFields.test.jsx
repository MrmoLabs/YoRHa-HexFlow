import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import DecodedFields from '../DecodedFields';

// R9（PLAN §8.46 · §8.37 R9 行 · C-2 选 B 前半）：命中应答解码展示的纯呈现组件。
const DECODED = {
    fields: [
        {
            fieldId: 'v', name: 'VOLTAGE', opCode: 'FLOAT_IEEE', byteLen: 4,
            start: 2, end: 6, truncated: false, value: 3.14
        },
        {
            fieldId: 'm', name: 'MODE', opCode: 'INT_UNSIGNED', byteLen: 1,
            start: 6, end: 7, truncated: false, value: 1
        }
    ],
    consumed: 7,
    total: 7,
    residual: 0,
    warnings: []
};

describe('DecodedFields（R9 命中应答解码展示）', () => {
    it('渲染字段名 + 值 + 字段/字节统计；decoded 为 null 不渲染', () => {
        const { rerender } = render(<DecodedFields decoded={DECODED} />);

        const list = screen.getByTestId('decoded-fields');
        expect(list.textContent).toContain('VOLTAGE');
        expect(list.textContent).toContain('3.14');
        expect(list.textContent).toContain('MODE');
        expect(document.body.textContent).toContain('2F / 7B');
        expect(screen.queryByTestId('decoded-warnings')).toBeNull();

        rerender(<DecodedFields decoded={null} />);
        expect(screen.queryByTestId('decoded-fields')).toBeNull();
    });

    it('warning 照登不藏；尾部残字节数进统计头', () => {
        render(<DecodedFields decoded={{
            ...DECODED,
            residual: 3,
            warnings: ['响应尾部多出 3 字节未映射到任何字段']
        }} />);
        expect(screen.getByTestId('decoded-warnings').textContent).toContain('多出 3 字节');
        expect(document.body.textContent).toContain('+3B');
    });

    it('空字段且无警告 → 不渲染（解不出时不占位）', () => {
        render(<DecodedFields decoded={{ fields: [], consumed: 0, total: 0, residual: 0, warnings: [] }} />);
        expect(screen.queryByTestId('decoded-fields')).toBeNull();
    });
});

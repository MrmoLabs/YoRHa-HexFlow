import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ParamConfigForm from '../ParamConfigForm';

describe('ParamConfigForm', () => {
    it('should coerce array config values into a scalar select value', () => {
        render(
            <ParamConfigForm
                blockState={{
                    id: 'block-1',
                    name: '校验码',
                    op_code: 'CHECKSUM_CRC',
                    parameter_config: {
                        algo: ['ADD_SUM']
                    }
                }}
                instructionFields={[]}
                operatorTemplates={{
                    CHECKSUM_CRC: {
                        op_code: 'CHECKSUM_CRC',
                        param_template: {
                            algo: ['CRC16_CCITT', 'CRC32', 'XOR_SUM', 'ADD_SUM']
                        }
                    }
                }}
                onUpdateParam={vi.fn()}
                hexInputMode="HEX"
                setHexInputMode={vi.fn()}
                onOpenDatePicker={vi.fn()}
                onStartPicking={vi.fn()}
                onStopPicking={vi.fn()}
                pickingMode={{ isActive: false }}
            />
        );

        expect(screen.getByDisplayValue('ADD_SUM')).toBeDefined();
    });
});

import { useState, useEffect, useMemo, useCallback } from 'react';
import { InstructionEncoder } from '../utils/InstructionEncoder';

export function useInstructionForm(instruction) {
    const [inputs, setInputs] = useState({});

    // Content signature: reset defaults when the instruction CONTENT changes
    // (id switch, refetch adding/renaming fields, revert). Identity-only deps
    // would miss same-id content updates; identical re-created objects keep
    // the signature stable so in-progress inputs are NOT needlessly discarded.
    const instructionSignature = instruction ? JSON.stringify(instruction) : '';
    useEffect(() => {
        // 选中指令 → 用初始值重置表单草稿（id 换了、refetch/撤销之后也一样）。
        // 这是「外部数据 → 本地草稿」的单向同步：重置时机必须由 instructionSignature
        // 说了算，不能跟随每次渲染。
        if (instruction?.id) {
            const defaults = InstructionEncoder.getInitialValues(instruction);
            setInputs(defaults);
        } else if (!instruction) {
            setInputs({});
        }
        // 不列 instruction：签名已经是「整份 instruction 序列化」的等价触发条件，
        // 列原始对象会让每次渲染（新对象字面量）都重置表单，正在输入的值被冲掉。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [instructionSignature]);

    // Handle single field update
    const handleInputChange = useCallback((fieldId, value) => {
        setInputs(prev => ({
            ...prev,
            [fieldId]: value
        }));
    }, []);

    // Reactive Calculations
    // We memoize the results so we don't re-run on purely visual renders,
    // only when inputs or instruction changes.
    const { computedValues, hexPreview, byteMap } = useMemo(() => {
        if (!instruction) return { computedValues: {}, hexPreview: '', byteMap: [] };

        const computed = InstructionEncoder.resolveDependencies(instruction, inputs);
        const { hexString, byteMap: map } = InstructionEncoder.encodeInstruction(instruction, inputs, computed);

        return {
            computedValues: computed,
            hexPreview: hexString,
            byteMap: map
        };
    }, [instruction, inputs]);

    return {
        inputs,
        handleInputChange,
        computedValues,
        hexPreview,
        byteMap,
        setInputs // Exposed for reset/bulk set if needed
    };
}

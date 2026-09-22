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
        if (instruction?.id) {
            const defaults = InstructionEncoder.getInitialValues(instruction);
            setInputs(defaults);
        } else if (!instruction) {
            setInputs({});
        }
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

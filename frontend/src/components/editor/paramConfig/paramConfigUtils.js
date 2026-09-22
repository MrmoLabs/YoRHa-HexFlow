// Shared helpers for the generic operator parameter form (ParamConfigForm).

export const toControlledScalar = (value, fallback = '') => {
    if (Array.isArray(value)) {
        return value.length > 0 ? String(value[0]) : fallback;
    }
    if (value === undefined || value === null) {
        return fallback;
    }
    return String(value);
};

// TYPE INFERENCE:
// 1. If it's a known keyword, use it as type
// 2. If it matches a pattern (e.g. ISO date), infer type
// 3. Otherwise infer from typeof value
export const inferConfigType = (rawConfig) => {
    const keywords = ['datetime', 'number', 'string', 'field_picker', 'kv_pair_list', 'input'];
    let configType = rawConfig;

    if (typeof rawConfig === 'string') {
        if (!keywords.includes(rawConfig)) {
            // If it looks like a date, it's a datetime
            if (rawConfig.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)) configType = 'datetime';
            else configType = 'string';
        }
    } else if (typeof rawConfig === 'number') {
        configType = 'number';
    }

    return configType;
};

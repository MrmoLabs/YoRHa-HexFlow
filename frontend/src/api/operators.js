import { API_BASE, handleResponse } from './client';

// Operator templates
export const getOperatorTemplates = async () => {
    const response = await fetch(`${API_BASE}/operator_templates/`);
    return handleResponse(response);
};

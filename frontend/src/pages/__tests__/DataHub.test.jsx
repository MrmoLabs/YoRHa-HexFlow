import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DataHub from '../DataHub';
import { api } from '../../api';
import { triggerBlobDownload } from '../../utils/download';

vi.mock('../../api', () => ({
    api: {
        getDatahubStatus: vi.fn(),
        createDbBackup: vi.fn(),
        restoreDbBackup: vi.fn(),
        exportDataBundle: vi.fn(),
        importRelations: vi.fn(),
        getInstructions: vi.fn(),
        getBindings: vi.fn(),
        getProtocols: vi.fn()
    }
}));

vi.mock('../../utils/download', () => ({
    triggerBlobDownload: vi.fn()
}));

const STATUS = {
    appVersion: '0.2.0',
    dbPath: 'D:/Projects/YoRHa/backend/db/yorha.db',
    dbExists: true,
    dbSizeBytes: 53248,
    dbModifiedAt: '2026-09-22T18:37:50',
    counts: {
        instructions: 15,
        instructionFields: 30,
        bitFields: 0,
        protocols: 3,
        operatorTemplates: 13
    },
    backups: [
        { name: 'yorha-20260922-120000.db', sizeBytes: 53248, modifiedAt: '2026-09-22T12:00:00', isSafetySnapshot: false }
    ],
    backupsDir: 'D:/Projects/YoRHa/backend/db/backups'
};

describe('DataHub Page', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('renders environment status from the API on mount', async () => {
        api.getDatahubStatus.mockResolvedValue(STATUS);

        render(<DataHub />);

        await waitFor(() => {
            expect(screen.getByText('0.2.0')).toBeDefined();
        });
        expect(screen.getByText('D:/Projects/YoRHa/backend/db/yorha.db')).toBeDefined();
        expect(screen.getByText('15')).toBeDefined(); // instructions count
        expect(screen.getByText('30')).toBeDefined(); // fields count
        expect(api.getDatahubStatus).toHaveBeenCalledTimes(1);
    });

    it('shows an error line and keeps panels usable when status fails', async () => {
        api.getDatahubStatus.mockRejectedValue(new Error('network down'));

        render(<DataHub />);

        await waitFor(() => {
            expect(screen.getByText(/ERR: network down/)).toBeDefined();
        });
        expect(screen.getByText('状态不可用')).toBeDefined();
        expect(screen.getByRole('button', { name: /刷新/ })).toBeDefined();
    });

    it('exports the aggregate bundle ZIP and triggers a download', async () => {
        api.getDatahubStatus.mockResolvedValue({ ...STATUS, backups: [] });
        api.exportDataBundle.mockResolvedValue(new Blob(['zip'], { type: 'application/zip' }));

        render(<DataHub />);
        await waitFor(() => expect(api.getDatahubStatus).toHaveBeenCalled());

        fireEvent.click(screen.getByRole('button', { name: /下载 ZIP/ }));

        await waitFor(() => {
            expect(api.exportDataBundle).toHaveBeenCalledTimes(1);
            expect(triggerBlobDownload).toHaveBeenCalledTimes(1);
        });
        const [, filename] = triggerBlobDownload.mock.calls[0];
        expect(filename).toMatch(/^yorha-datahub-\d+\.zip$/);
        expect(screen.getByText(/导出完成/)).toBeDefined();
    });

    it('creates a backup then refreshes the status list', async () => {
        api.getDatahubStatus.mockResolvedValue({ ...STATUS, backups: [] });
        api.createDbBackup.mockResolvedValue({
            created: { name: 'yorha-20260922-120001.db', sizeBytes: 53248, modifiedAt: '2026-09-22T12:00:01', isSafetySnapshot: false }
        });

        render(<DataHub />);
        await waitFor(() => expect(api.getDatahubStatus).toHaveBeenCalled());

        fireEvent.click(screen.getByRole('button', { name: /新建备份/ }));

        await waitFor(() => {
            expect(api.createDbBackup).toHaveBeenCalledTimes(1);
            expect(api.getDatahubStatus).toHaveBeenCalledTimes(2); // 初始 + 备份后刷新
        });
        expect(screen.getByText(/备份完成：yorha-20260922-120001\.db/)).toBeDefined();
    });

    it('requires confirmation before restoring a backup', async () => {
        api.getDatahubStatus.mockResolvedValue(STATUS);
        api.restoreDbBackup.mockResolvedValue({
            restored: 'yorha-20260922-120000.db',
            safetySnapshot: 'pre-restore-20260922-120001.db',
            notice: 'ok'
        });

        render(<DataHub />);
        await waitFor(() => expect(screen.getByText('yorha-20260922-120000.db')).toBeDefined());

        fireEvent.click(screen.getByRole('button', { name: /恢复 \(RESTORE\)/ }));
        // 确认弹窗出现，尚未调用 API
        expect(screen.getByText(/确认从备份恢复数据库/)).toBeDefined();
        expect(api.restoreDbBackup).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: /确认/ }));
        await waitFor(() => {
            expect(api.restoreDbBackup).toHaveBeenCalledWith('yorha-20260922-120000.db');
        });
        expect(screen.getByText(/安全快照：pre-restore-20260922-120001\.db/)).toBeDefined();
        await waitFor(() => {
            expect(api.getDatahubStatus).toHaveBeenCalledTimes(2);
        });
    });

    it('cancels restore without calling the API', async () => {
        api.getDatahubStatus.mockResolvedValue(STATUS);

        render(<DataHub />);
        await waitFor(() => expect(screen.getByText('yorha-20260922-120000.db')).toBeDefined());

        fireEvent.click(screen.getByRole('button', { name: /恢复 \(RESTORE\)/ }));
        fireEvent.click(screen.getByRole('button', { name: /取消/ }));

        expect(api.restoreDbBackup).not.toHaveBeenCalled();
        expect(screen.queryByText(/确认从备份恢复数据库/)).toBeNull();
    });

    // ─── 批次四 4a: relations.json 导入导出 ─────────────────────────────
    // jsdom 兼容: 旧 jsdom 的 File 无 .text() → 实例级兜底（页面 handler 走 file.text()）
    const makeJsonFile = (content, name = 'relations.json') => {
        const file = new File([content], name, { type: 'application/json' });
        if (typeof file.text !== 'function') file.text = async () => content;
        return file;
    };
    const RELATIONS = {
        schemaVersion: 1,
        bindings: [{ id: 'b1' }, { id: 'b2' }],
        responseSpecs: [{ id: 'rs1' }]
    };

    it('4a 导出完成回显含 relations.json 与两张关系表计数', async () => {
        api.getDatahubStatus.mockResolvedValue({
            ...STATUS,
            counts: { ...STATUS.counts, protocolBindings: 7, responseSpecs: 2 }
        });
        api.exportDataBundle.mockResolvedValue(new Blob(['zip'], { type: 'application/zip' }));

        render(<DataHub />);
        await waitFor(() => expect(screen.getByText('绑定 BINDINGS')).toBeDefined());
        expect(screen.getByText('应答规格 SPECS')).toBeDefined();
        expect(screen.getByText('7')).toBeDefined();

        fireEvent.click(screen.getByRole('button', { name: /下载 ZIP/ }));
        await waitFor(() => expect(screen.getByText(/导出完成/)).toBeDefined());
        // 回显行含 4a 新增的 relations.json（面板段落也提到它 → 断言回显行本身）
        expect(screen.getByText(/导出完成/).textContent).toMatch(/relations\.json/);
    });

    it('4a 导入关系数据: 选文件 → 弹确认(未发请求) → 确认才 POST 原文并回报 + 刷新', async () => {
        api.getDatahubStatus.mockResolvedValue(STATUS);
        api.importRelations.mockResolvedValue({
            bindings: { imported: 1, updated: 1, skipped: [] },
            responseSpecs: { imported: 1, updated: 0, skipped: [] },
            warnings: []
        });

        render(<DataHub />);
        await waitFor(() => expect(api.getDatahubStatus).toHaveBeenCalled());

        fireEvent.change(screen.getByTestId('relations-import-input'), {
            target: { files: [makeJsonFile(JSON.stringify(RELATIONS))] }
        });

        await waitFor(() => expect(screen.getByText(/确认导入关系数据/)).toBeDefined());
        expect(screen.getByText(/绑定 2 条 · 应答规格 1 条/)).toBeDefined();
        expect(api.importRelations).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: /确认/ }));
        await waitFor(() => expect(api.importRelations).toHaveBeenCalledWith(RELATIONS));
        await waitFor(() => expect(screen.getByText(/导入完成/)).toBeDefined());
        expect(screen.getByText(/绑定 新增 1 \/ 更新 1 \/ 跳过 0/)).toBeDefined();
        expect(screen.getByText(/应答规格 新增 1 \/ 更新 0 \/ 跳过 0/)).toBeDefined();
        expect(screen.getByText(/警告 0 条/)).toBeDefined();
        await waitFor(() => expect(api.getDatahubStatus).toHaveBeenCalledTimes(2)); // 初始 + 导入后刷新
    });

    it('4a 取消导入: 不发 POST、弹窗关闭', async () => {
        api.getDatahubStatus.mockResolvedValue(STATUS);

        render(<DataHub />);
        await waitFor(() => expect(api.getDatahubStatus).toHaveBeenCalled());

        fireEvent.change(screen.getByTestId('relations-import-input'), {
            target: { files: [makeJsonFile(JSON.stringify(RELATIONS))] }
        });
        await waitFor(() => expect(screen.getByText(/确认导入关系数据/)).toBeDefined());
        fireEvent.click(screen.getByRole('button', { name: /取消/ }));

        expect(api.importRelations).not.toHaveBeenCalled();
        expect(screen.queryByText(/确认导入关系数据/)).toBeNull();
    });

    it('4a 非法 JSON / 非关系包直接报错，不出弹窗不发请求', async () => {
        api.getDatahubStatus.mockResolvedValue(STATUS);

        render(<DataHub />);
        await waitFor(() => expect(api.getDatahubStatus).toHaveBeenCalled());
        const input = screen.getByTestId('relations-import-input');

        fireEvent.change(input, { target: { files: [makeJsonFile('{oops')] } });
        await waitFor(() => expect(screen.getByText(/不是合法 JSON/)).toBeDefined());
        expect(screen.queryByText(/确认导入关系数据/)).toBeNull();

        fireEvent.change(input, { target: { files: [makeJsonFile(JSON.stringify({ foo: 1 }))] } });
        await waitFor(() => expect(screen.getByText(/缺 bindings \/ responseSpecs/)).toBeDefined());
        expect(api.importRelations).not.toHaveBeenCalled();
    });

    // ─── 批次四 4b: 绑定矩阵（指令 → 默认协议 → 槽位） ─────────────────────
    const seedMatrix = () => {
        api.getDatahubStatus.mockResolvedValue(STATUS);
        api.getInstructions.mockResolvedValue([
            { id: 'i-heart', code: 'DEMO-001', name: '示例心跳帧', device_code: 'DEMO-DEV' },
            { id: 'i-loose', code: 'DEMO-003', name: '未绑定指令', device_code: 'DEMO-DEV' }
        ]);
        api.getProtocols.mockResolvedValue([
            { id: 'p1', label: '协议一', children: [{ id: 's1', label: '外壳槽', type: 'slot' }] },
            { id: 'p2', label: '协议二', children: [] }
        ]);
        api.getBindings.mockResolvedValue([
            { id: 'b-def', protocol_id: 'p1', instruction_id: 'i-heart', label: '默认绑定',
                slot_order: 0, slot_id: 's1', is_default: true, stale: false },
            { id: 'b-other', protocol_id: 'p1', instruction_id: 'i-heart', label: '侧槽',
                slot_order: 1, slot_id: 'gone-slot', is_default: false, stale: true },
            { id: 'b-orphan', protocol_id: 'p2', instruction_id: 'i-loose', label: '侧绑定',
                slot_order: 0, slot_id: null, is_default: false, stale: null }
        ]);
    };

    it('4b 绑定矩阵: 摘要计数 + 默认协议/槽位 + 悬空槽与失效琥珀标出', async () => {
        seedMatrix();

        render(<DataHub />);
        await waitFor(() => expect(screen.getByTestId('matrix-summary')).toBeDefined());

        const summary = screen.getByTestId('matrix-summary').textContent;
        expect(summary).toContain('指令 2');
        expect(summary).toContain('有默认协议 1');
        expect(summary).toContain('无绑定 0');
        expect(summary).toContain('绑定 3');
        expect(summary).toContain('悬空槽 1');
        expect(summary).toContain('失效绑定 1');

        const matrixSection = screen.getByTestId('binding-matrix').textContent;
        expect(matrixSection).toContain('DEMO-001');
        expect(matrixSection).toContain('协议一');
        expect(matrixSection).toContain('外壳槽');             // 显式槽 → 节点标签
        expect(matrixSection).toContain('悬空 gone-slot');     // 槽已删 → 不静默
        expect(matrixSection).toContain('[失效]');             // stale === true 才亮
        expect(matrixSection).toContain('DEMO-003');
        expect(matrixSection).toContain('按序 0');             // 无显式槽 → slot_order
        expect(matrixSection).toContain('协议二');
    });

    it('4b 绑定矩阵: 零绑定提示补齐入口；刷新后矩阵随 refresh 重读', async () => {
        api.getDatahubStatus.mockResolvedValue(STATUS);
        api.getInstructions.mockResolvedValue([{ id: 'i1', code: 'DEMO-001', name: '心跳', device_code: 'D1' }]);
        api.getProtocols.mockResolvedValue([]);
        api.getBindings.mockResolvedValue([]);

        render(<DataHub />);
        await waitFor(() => expect(screen.getByTestId('matrix-summary')).toBeDefined());
        expect(screen.getByTestId('matrix-summary').textContent).toContain('无绑定 1');
        expect(screen.getByText(/尚未指定默认协议/)).toBeDefined();

        fireEvent.click(screen.getByRole('button', { name: /刷新/ }));
        await waitFor(() => expect(api.getDatahubStatus).toHaveBeenCalledTimes(2));
        // 刷新后矩阵随 refresh 重读（三读再次命中 mock）
        expect(screen.getByTestId('matrix-summary').textContent).toContain('指令 1');
    });
});

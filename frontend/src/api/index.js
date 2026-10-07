// Barrel for all HTTP calls. Import via `import { api } from '../api'`
// (directory import resolves here, keeping the original `./api` path stable).
import {
    getProtocols,
    getProtocol,
    createProtocol,
    updateProtocol,
    deleteProtocol
} from './protocols';
import {
    getInstructions,
    getInstruction,
    createInstruction,
    updateInstruction,
    deleteInstruction,
    getInstructionReferences
} from './instructions';
import { getOperatorTemplates } from './operators';
import { exportHexFile, exportBinaryFromBlocks } from './export';
import { compileWrapped } from './compile';
import { dispatchPayload, dispatchWrappedGroup, getDispatchHistory, clearDispatchHistory, resolveRoute } from './dispatch';
import { getTransportConfig, setTransportConfig, getTransportStatus, revertTransportConfig, getTransportPorts } from './transport';
import { getBindings, createBinding, updateBinding, deleteBinding } from './bindings';
import { getRecipes, getRecipe, createRecipe, updateRecipe, deleteRecipe } from './recipes';
import { getDatahubStatus, createDbBackup, restoreDbBackup, exportDataBundle, importRelations, importDomain } from './datahub';
import { getProfiles, createProfile, updateProfile, deleteProfile, activateProfile, reorderProfiles } from './profiles';
// R6（PLAN §8.43）：软删除 / 回收站 —— 列条目 / 恢复 / 彻底删除
import { listTrash, restoreTrashItem, purgeTrashItem } from './trash';
// R38（PLAN §8.70）：发前路由规则 CRUD（/routing-rules 五方法）
import { listRoutingRules, getRoutingRule, createRoutingRule, updateRoutingRule, deleteRoutingRule } from './routing';
import { getResponseSpec, saveResponseSpec, deleteResponseSpec, getResponseSpecTargets, generateResponseSpec, sendTransaction } from './responseSpecs';
import {
    listSequences,
    getSequence,
    createSequence,
    updateSequence,
    deleteSequence,
    startSequence,
    stopSequence,
    getSequenceStatus
} from './sequences';

export const api = {
    // Protocols
    getProtocols,
    getProtocol,
    createProtocol,
    updateProtocol,
    deleteProtocol,

    // Instructions
    getInstructions,
    getInstruction,
    createInstruction,
    updateInstruction,
    deleteInstruction,
    // 批次二 (D12/D14②): 删前引用计数（弹窗列受影响项后再确认）
    getInstructionReferences,

    // Operators
    getOperatorTemplates,

    // Export (binary / hex file download)
    exportHexFile,
    exportBinaryFromBlocks,

    // Compile（批次一 D4-A: 后端唯一封装入口 POST /compile/wrapped）
    compileWrapped,

    // Dispatch / transport (loopback default; TCP/serial via /transport/config)
    dispatchPayload,
    // 批次二 (D14③): 试发多载荷组带 wrap 下发（后端先转义内核再套壳）
    dispatchWrappedGroup,
    getDispatchHistory,
    clearDispatchHistory,
    // R39（PLAN §8.71）：发前路由解析 —— 只解析不发送，无命中后端 matched=false 不猜
    resolveRoute,
    getTransportConfig,
    setTransportConfig,
    getTransportStatus,
    // R2（PLAN §8.37）：一键回退到上一配置（进程内回退栈，零 DDL）
    revertTransportConfig,
    // R14（PLAN §8.49）：本机串口端口枚举（只读，缺 pyserial 降级不抛）
    getTransportPorts,

    // Bindings (E4: 编排绑定持久化 → /bindings CRUD, 槽序 slot_order 由后端分配)
    getBindings,
    createBinding,
    updateBinding,
    deleteBinding,

    // Recipes (CP3 3a · D13: 封装配方 → /recipes CRUD；definition_hash 后端算)
    getRecipes,
    getRecipe,
    createRecipe,
    updateRecipe,
    deleteRecipe,

    // Data Hub (C3: status / aggregate export / db backup & restore)
    // 批次四 4a: relations.json（绑定 + 应答规格）导入导出
    // R8（PLAN §8.46）: 按域导入 —— R7 出线的 5 个新域回灌
    getDatahubStatus,
    createDbBackup,
    restoreDbBackup,
    exportDataBundle,
    importRelations,
    importDomain,

    // Profiles (P1: 设备档案 → /profiles CRUD + activate，传输配置命名快照)
    // R20 (§8.50 ②-3): reorderProfiles → PUT /profiles/order 整表顺序一次提交
    getProfiles,
    createProfile,
    updateProfile,
    deleteProfile,
    activateProfile,
    reorderProfiles,

    // Trash (R6 · PLAN §8.43: 软删除回收站 —— 列条目 / 恢复 / 彻底删除)
    listTrash,
    restoreTrashItem,
    purgeTrashItem,

    // Routing rules (R38 · PLAN §8.70: 发前路由规则 CRUD，只解析口径在 BE)
    listRoutingRules,
    getRoutingRule,
    createRoutingRule,
    updateRoutingRule,
    deleteRoutingRule,

    // Response specs / transaction (P2: 应答规格按指令持久化 + /dispatch/transaction)
    getResponseSpec,
    saveResponseSpec,
    deleteResponseSpec,
    // CP3 3d (D5-A): 协议页「据此生成」—— 候选指令 + 分层链生成入口
    getResponseSpecTargets,
    generateResponseSpec,
    sendTransaction,

    // Sequences (P3 后端 + P4 页面: 定义 CRUD / 启停 / status 1.5s 轮询)
    listSequences,
    getSequence,
    createSequence,
    updateSequence,
    deleteSequence,
    startSequence,
    stopSequence,
    getSequenceStatus
};

export default api;

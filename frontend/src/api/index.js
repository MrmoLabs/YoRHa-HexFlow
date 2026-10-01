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
import { dispatchPayload, dispatchWrappedGroup, getDispatchHistory, clearDispatchHistory } from './dispatch';
import { getTransportConfig, setTransportConfig, getTransportStatus } from './transport';
import { getBindings, createBinding, updateBinding, deleteBinding } from './bindings';
import { getRecipes, getRecipe, createRecipe, updateRecipe, deleteRecipe } from './recipes';
import { getDatahubStatus, createDbBackup, restoreDbBackup, exportDataBundle } from './datahub';
import { getProfiles, createProfile, updateProfile, deleteProfile, activateProfile } from './profiles';
import { getResponseSpec, saveResponseSpec, deleteResponseSpec, sendTransaction } from './responseSpecs';
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
    getTransportConfig,
    setTransportConfig,
    getTransportStatus,

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
    getDatahubStatus,
    createDbBackup,
    restoreDbBackup,
    exportDataBundle,

    // Profiles (P1: 设备档案 → /profiles CRUD + activate，传输配置命名快照)
    getProfiles,
    createProfile,
    updateProfile,
    deleteProfile,
    activateProfile,

    // Response specs / transaction (P2: 应答规格按指令持久化 + /dispatch/transaction)
    getResponseSpec,
    saveResponseSpec,
    deleteResponseSpec,
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

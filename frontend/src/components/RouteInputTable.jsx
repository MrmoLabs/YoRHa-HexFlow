// R40（PLAN §8.72）：发前路由的**输入行表** —— 加工页「路由输入」（R39）与规则页
// 「试解析」（R40）共用的那张扁平键值表。
//
// 为什么要抽出来：两张表的**判定逻辑**本就只有一份（`utils/routeResolve` 的
// `toInputsMap` / `parseInputValue`），若排版再抄一遍，类型徽标（当场看见这行会按
// 什么类型发出去）、空键不发、删到只剩一行禁删这几条细口径就会有两个出处慢慢走样。
//
// 边界划在「排版」上 —— 本组件只管渲染行，**不持有状态、不发请求、不加按钮**：
//  · 行状态与 setter 归调用方（`rows` + `onChange(nextRows)`，值形式不收 updater 形；
//  · 「+ 添加 ADD」归调用方：两页的按钮视觉语言不同（加工页 RouteButton、
//    规则页 ActionButton），把这层差异塞进共用组件只会让两边都不像自己；
//  · 回执怎么翻译也归调用方（`describeResolve` / `describeDryRun`）。
//
// `idPrefix` / `labels` 默认值 = 加工页原文，故 R39 那 40 条既有用例零改全绿
// （aria-label `路由键 N`、testid `route-type-N` 逐字未变）。
//
// 本仓未装 @testing-library/jest-dom → 组件里不依赖 matchers 扩展。
import React from 'react';
import { describeInputType, patchRouteInput, removeRouteInput } from '../utils/routeResolve';

const DEFAULT_LABELS = { key: '路由键', value: '路由值', remove: '删除输入' };

export default function RouteInputTable({
    rows = [],
    onChange,
    idPrefix = 'route',
    labels = DEFAULT_LABELS,
}) {
    const label = { ...DEFAULT_LABELS, ...labels };
    const list = rows || [];

    return (
        <>
            {list.length === 0 && (
                <div className="text-[10px] font-mono opacity-50">
                    无输入行 —— 点「+ 添加 ADD」加一行。
                </div>
            )}
            {list.map((row, index) => (
                <div key={`${idPrefix}-input-${index}`} className="flex items-center gap-2">
                    <input
                        id={`${idPrefix}-key-${index}`}
                        aria-label={`${label.key} ${index + 1}`}
                        type="text"
                        value={row.key}
                        placeholder="meter_id"
                        onChange={(e) => onChange(patchRouteInput(list, index, { key: e.target.value }))}
                        className="w-40 shrink-0 border border-nier-light/40 bg-nier-dark px-2 py-1 text-[11px] font-mono text-nier-light focus:border-nier-light"
                    />
                    <input
                        id={`${idPrefix}-value-${index}`}
                        aria-label={`${label.value} ${index + 1}`}
                        type="text"
                        value={row.value}
                        placeholder="0001"
                        onChange={(e) => onChange(patchRouteInput(list, index, { value: e.target.value }))}
                        className="min-w-0 flex-1 border border-nier-light/40 bg-nier-dark px-2 py-1 text-[11px] font-mono text-nier-light focus:border-nier-light"
                    />
                    {/* 当场显示这行会按什么类型发出去（值按 JSON 标量解析） */}
                    <span
                        data-testid={`${idPrefix}-type-${index}`}
                        title={`按${describeInputType(row.value)}发送`}
                        className="shrink-0 border border-nier-light/30 px-1.5 py-1 text-[9px] font-mono tracking-[0.15em] text-muted"
                    >
                        {describeInputType(row.value)}
                    </span>
                    <button
                        type="button"
                        aria-label={`${label.remove} ${index + 1}`}
                        title={`${label.remove} ${index + 1}`}
                        onClick={() => onChange(removeRouteInput(list, index))}
                        disabled={list.length <= 1}
                        className="border border-nier-light/40 px-2 py-1 text-[10px] font-mono text-muted transition-colors duration-150 enabled:hover:border-nier-light enabled:hover:bg-nier-light enabled:hover:text-nier-dark disabled:opacity-30"
                    >
                        ×
                    </button>
                </div>
            ))}
        </>
    );
}

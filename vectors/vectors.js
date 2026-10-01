// CP2b 共享向量加载器（D11 分段 ①：向量表共享 fixture 化）。
//
// 单一真相源 = 本目录 *.json，两端测试只读这里，新增/修改向量只写一处。
// 用法（测试文件里，路径按自身位置上溯到仓库根）：
//   import { loadVectors } from '../../../../vectors/vectors.js';
//   import intSigned from '../../../../vectors/int_signed.json';
//   const VECTORS = loadVectors(intSigned);
//
// 跨语言特殊值约定（2026-10-01 拍板，JSON 无 Infinity/NaN）：
//   {"$v":"Infinity"} / {"$v":"-Infinity"} / {"$v":"NaN"}
// 其余标量按 JSON 原型天然分型（null / true / 数字 / 字符串），
// 因此字符串输入 "1e3"、"" 与数值 1.5 不会互相混淆。
// 与后端 vectors/load_vectors.py 逐条同口径，改一必改二。

const SPECIAL = {
    Infinity: Infinity,
    '-Infinity': -Infinity,
    NaN: NaN,
};

export const loadVectors = (node) => {
    if (Array.isArray(node)) return node.map(loadVectors);
    if (node !== null && typeof node === 'object') {
        const keys = Object.keys(node);
        if (keys.includes('$v')) {
            if (keys.length !== 1 || !(node.$v in SPECIAL)) {
                throw new Error(`非法 $v 标记: ${JSON.stringify(node)}`);
            }
            return SPECIAL[node.$v];
        }
        return Object.fromEntries(keys.map((k) => [k, loadVectors(node[k])]));
    }
    return node;
};

export default loadVectors;

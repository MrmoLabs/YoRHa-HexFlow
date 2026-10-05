from typing import List, Tuple
# R34（§8.66 排期 · 校验和字节序）: 与 LengthHandler **同用 handlers.base 的
# 字节序门面**（同判据，不留第二套）—— 缺省 / 枚举外 fail-open 回大端，出线
# 逐字节与本批之前一致（§0 硬约束）。
from backend.handlers.base import LogicHandler, apply_byte_order
from backend.schemas.block import Block

class ChecksumHandler(LogicHandler):
    def calculate(self, block: Block, flattened_blocks: List[Tuple[str, Block]]) -> str:
        if not block.config:
            return "00" * block.byte_length

        algo = block.config.params.get("algorithm", "sum")
        refs = block.config.params.get("refs")
        if isinstance(refs, list):
            # 批次四 (R2 打通): refs 集合模式 —— frontend toFrameBlocks 出口把
            # parameter_config.refs 按数组序展开成叶子 id 列表写入 params.refs。
            # 与前端 PASS2「逐 ref 取字节、按 refs 序拼接」对齐；range 模式
            # （下方 target_start/end）只覆盖连续区间，非连续 refs 会把区间内
            # 无关块算进来，故集合语义必须走此分支。同一 id 在流中出现多次
            # （repeat 展开）→ 每次出现都计入（前端组 ref 同样按重复取字节）。
            # 空集/全不可用 → 全 0（前端 calculateChecksum 对空字节返回 0）。
            data_bytes = bytearray()
            for ref_id in refs:
                for _layer_id, b in flattened_blocks:
                    if b.id != ref_id:
                        continue
                    if b.id == block.id or not b.is_enabled or b.type == "slot":
                        continue
                    val = b.hex_value or ("00" * b.byte_length)
                    try:
                        data_bytes.extend(bytes.fromhex(val.replace(" ", "")))
                    except ValueError:
                        pass
            if not data_bytes:
                return "00" * block.byte_length
            result = 0
            if algo == "sum":
                result = sum(data_bytes) % (256 ** block.byte_length)
            elif algo == "xor":
                for b in data_bytes:
                    result ^= b
            elif algo == "crc16_modbus":
                result = self.crc16(data_bytes)
            # R22 (§8.52 排期 · CRC 多算法): 三个新算法与 crc16_modbus 同位扩，
            # 缺省/枚举外仍走上方 sum → 出错路径不变，存量帧逐字节一致。
            elif algo == "crc16_ccitt":
                result = self.crc16_ccitt(data_bytes)
            elif algo == "crc32":
                result = self.crc32(data_bytes)
            elif algo == "lrc":
                result = self.lrc(data_bytes)
            # R34（§8.66）: 大端结果 → 按 byte_order 出线（little = 字节对反转；
            # 缺省/枚举外回大端，形状与本批之前一致）。
            return apply_byte_order(f"{result:0{block.byte_length * 2}X}", block)

        start_id = block.config.target_start_id
        end_id = block.config.target_end_id
        
        data_bytes = bytearray()
        in_range = False
        start_matched = False

        # Same range rules as LengthHandler: start = first match,
        # end only honored after start, missing end => end of stream.
        for layer_id, b in flattened_blocks:
            if not start_matched and b.id == start_id:
                start_matched = True
                in_range = True

            if in_range:
                if b.is_enabled and b.id != block.id and b.type != "slot":
                    val = b.hex_value or ("00" * b.byte_length)
                    try:
                        # Clean spaces
                        clean_val = val.replace(" ", "")
                        data_bytes.extend(bytes.fromhex(clean_val))
                    except ValueError:
                        pass

                if b.id == end_id:
                    in_range = False
                    break
                
        result = 0
        if algo == "sum":
            if len(data_bytes) > 0:
                result = sum(data_bytes) % (256 ** block.byte_length)
        elif algo == "xor":
             for b in data_bytes:
                result ^= b
        elif algo == "crc16_modbus":
             result = self.crc16(data_bytes)
        # R22 (§8.52 排期 · CRC 多算法): 区间模式与上方 refs 模式同步扩（两处口径
        # 必须一致，否则同一配置换一种引用方式就出不同字节）。
        elif algo == "crc16_ccitt":
            result = self.crc16_ccitt(data_bytes)
        elif algo == "crc32":
            result = self.crc32(data_bytes)
        elif algo == "lrc":
            result = self.lrc(data_bytes)
        
        # R34（§8.66）: 区间模式与 refs 模式**同位套用**字节序 —— 换一种引用方式
        # 不换出线形态（镜像 R22 算法同位扩的规矩）。
        return apply_byte_order(f"{result:0{block.byte_length * 2}X}", block)

    def crc16(self, data: bytearray, poly=0xA001):
        crc = 0xFFFF
        for byte in data:
            crc ^= byte
            for _ in range(8):
                if (crc & 0x0001):
                    crc = (crc >> 1) ^ poly
                else:
                    crc >>= 1
        return crc

    def crc16_ccitt(self, data: bytearray, poly=0x1021) -> int:
        """CRC-16/CCITT-FALSE（R22 · §8.52 排期）。

        poly 0x1021、init 0xFFFF、refin/refout = false、xorout 0x0000 —— 与
        formula.js calculateChecksum(CRC_16_CCITT)、response_match.crc16_ccitt
        逐位同源；标准 check 值 input "123456789" → 0x29B1。
        """
        crc = 0xFFFF
        for byte in data:
            crc ^= (byte << 8) & 0xFFFF
            for _ in range(8):
                if crc & 0x8000:
                    crc = ((crc << 1) ^ poly) & 0xFFFF
                else:
                    crc = (crc << 1) & 0xFFFF
        return crc

    def crc32(self, data: bytearray) -> int:
        """CRC-32/ISO-HDLC（R22 · §8.52 排期）。

        反射 poly 0xEDB88320、init/xorout 0xFFFFFFFF —— 与 formula.js
        calculateChecksum(CRC_32)、response_match.crc32 同源；
        标准 check 值 input "123456789" → 0xCBF43926。
        """
        crc = 0xFFFFFFFF
        for byte in data:
            crc ^= byte
            for _ in range(8):
                if crc & 1:
                    crc = (crc >> 1) ^ 0xEDB88320
                else:
                    crc >>= 1
        return crc ^ 0xFFFFFFFF

    def lrc(self, data: bytearray) -> int:
        """LRC（R22 · §8.52 排期）：8 位和的二进制补码 = (256 - sum%256) % 256。

        与 formula.js calculateChecksum(LRC)、response_match.lrc 同源；
        check 值 input "123456789" → 0x23。恒 1 字节值。
        """
        return (-sum(data)) & 0xFF

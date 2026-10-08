import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    // R51（PLAN §8.83）：mock 响应延迟注入 —— 缺省零行为变化，
    // `YORHA_API_DELAY_MS=15` 时把全仓竞态变成确定性失败（抖动排查用）。
    setupFiles: ['./test/setupDelay.js'],
  },
})

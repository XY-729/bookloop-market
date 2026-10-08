import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({
  plugins: [vue()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: { vue: ['vue'], element: ['element-plus', '@element-plus/icons-vue'] },
      },
    },
  },
  server: { proxy: { '/v1': 'http://127.0.0.1:3000', '/files': 'http://127.0.0.1:3000' } },
});

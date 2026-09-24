import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
const root = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(root, './@') } },
  build: {
    outDir: path.resolve(root, '../public/shell/assets'), emptyOutDir: false, target: 'es2020',
    rollupOptions: { input: path.resolve(root, 'src/features/admin/database-maintenance.tsx'),
      output: { entryFileNames: 'database-maintenance.js', inlineDynamicImports: true } },
  },
});

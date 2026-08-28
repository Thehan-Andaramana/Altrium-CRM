import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react()],
    css: {
      preprocessorOptions: {
        scss: {
          // Bootstrap 5.3's own SCSS still uses the legacy @import/mix()/etc.
          // APIs Dart Sass is deprecating -- quietDeps silences warnings that
          // originate from node_modules (Bootstrap) while still surfacing
          // any from our own src/styles files.
          quietDeps: true,
        },
      },
    },
    server: {
      port: Number(env.FRONTEND_PORT) || 3000,
      host: '127.0.0.1',
      proxy: {
        '/api': {
          target: env.BACKEND_URL || 'http://localhost:9000',
          changeOrigin: true,
        },
      },
    },
  }
})
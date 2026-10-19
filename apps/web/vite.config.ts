import { defineConfig } from 'vite';
export default defineConfig({ envDir: '../..', server: { proxy: { '/api': process.env.API_PROXY_TARGET || 'http://localhost:8787' } }, build: { target: 'es2022' } });

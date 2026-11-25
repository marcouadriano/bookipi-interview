import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Sale Service runs as two apps, so the dev proxy routes by path.
const waitingRoom = process.env.WAITING_ROOM_URL ?? 'http://localhost:3000';
const purchase = process.env.PURCHASE_URL ?? 'http://localhost:3002';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/sale': waitingRoom,
      '/api/queue': waitingRoom,
      '/api/purchase': purchase,
    },
  },
});

import type { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import { corsOrigins } from '../config/env';
import { loadAuthUser, verifyToken } from '../middleware/auth';
import { PERMISSIONS } from '../config/permissions';

let io: Server | null = null;

/**
 * Socket.IO for live kitchen screens and POS order updates.
 * Clients connect with: io(url, { auth: { token: '<JWT>' } })
 * Rooms: "kitchen" (all tickets), "station:<id>" (one station), "pos" (order/table updates).
 */
export function initRealtime(server: HttpServer) {
  io = new Server(server, { cors: { origin: corsOrigins, credentials: true } });

  io.use(async (socket, next) => {
    try {
      const token = String(socket.handshake.auth?.token ?? '');
      const payload = verifyToken(token);
      const user = await loadAuthUser(Number(payload.sub));
      socket.data.user = user;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const perms: Set<string> = socket.data.user.permissions;
    if (perms.has(PERMISSIONS.KITCHEN_VIEW)) {
      socket.join('kitchen');
      socket.on('station:join', (stationId: number) => socket.join(`station:${Number(stationId)}`));
      socket.on('station:leave', (stationId: number) => socket.leave(`station:${Number(stationId)}`));
    }
    if (perms.has(PERMISSIONS.ORDER_VIEW) || perms.has(PERMISSIONS.ORDER_CREATE)) socket.join('pos');
  });

  return io;
}

export function emit(event: string, payload: unknown, rooms: string[]) {
  if (!io) return;
  let target = io.to(rooms[0]);
  for (const r of rooms.slice(1)) target = target.to(r);
  target.emit(event, payload);
}

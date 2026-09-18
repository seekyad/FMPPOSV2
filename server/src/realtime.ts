import type { Server as SocketServer } from 'socket.io';
import { authenticateSession } from './auth';
import { findDevice } from './pairing';

export function configureRealtime(io: SocketServer) {
  io.use(async (socket, next) => {
    try {
      const auth = socket.handshake.auth;
      if (auth.kind === 'bridge' && typeof auth.deviceToken === 'string') {
        const device = await findDevice(auth.deviceToken, 'bridge');
        if (!device) return next(new Error('Bridge access denied'));
        socket.data.identity = { kind: 'bridge', storeId: device.storeId, terminalId: device.id };
      } else if (typeof auth.token === 'string') {
        const user = await authenticateSession(auth.token);
        if (!user) return next(new Error('Session expired or access revoked'));
        socket.data.identity = { kind: 'pos', storeId: user.storeId, terminalId: user.terminalId, userId: user.id };
      } else return next(new Error('Authentication required'));
      next();
    } catch { next(new Error('Authentication unavailable')); }
  });

  io.on('connection', (socket) => {
    const identity = socket.data.identity;
    void socket.join('terminal:' + identity.terminalId);
    if (identity.kind === 'bridge') {
      void socket.join('bridge:' + identity.storeId);
      io.to('store:' + identity.storeId).emit('bridge-status', { online: true });
    } else {
      void socket.join('store:' + identity.storeId);
      void socket.join('user:' + identity.userId);
    }
    const stillAuthorized = async () => {
      if (identity.kind === 'bridge') {
        const device = await findDevice(socket.handshake.auth.deviceToken, 'bridge');
        return Boolean(device && device.id === identity.terminalId && device.storeId === identity.storeId);
      }
      const user = await authenticateSession(socket.handshake.auth.token);
      return Boolean(user && user.id === identity.userId && user.storeId === identity.storeId);
    };
    socket.use((_packet, next) => {
      void stillAuthorized().then(valid => {
        if (valid) next();
        else { socket.disconnect(true); next(new Error('Access revoked')); }
      }).catch(() => { socket.disconnect(true); });
    });
    socket.on('join-store', (storeId: number) => {
      if (identity.kind !== 'pos' || storeId !== identity.storeId) socket.disconnect(true);
    });
    socket.on('bridge-online', (storeId: number) => {
      if (identity.kind !== 'bridge' || storeId !== identity.storeId) socket.disconnect(true);
    });
    const recheck = setInterval(() => {
      void stillAuthorized().then(valid => { if (!valid) socket.disconnect(true); }).catch(() => socket.disconnect(true));
    }, 15_000);
    recheck.unref();
    socket.on('disconnect', () => {
      clearInterval(recheck);
      if (identity.kind === 'bridge') {
        const online = Boolean(io.sockets.adapter.rooms.get('bridge:' + identity.storeId)?.size);
        io.to('store:' + identity.storeId).emit('bridge-status', { online });
      }
    });
  });
}

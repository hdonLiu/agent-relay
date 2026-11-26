import WebSocket from 'ws';

export function deviceStream({ url, token, deviceId, onOpen, onFrame, onError }) {
  const endpoint = new URL('/v1/device-stream', url);
  endpoint.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  let socket, retryTimer, heartbeat, stopped = false, attempt = 0;

  function connect() {
    if (stopped) return;
    socket = new WebSocket(endpoint, {
      headers: { authorization: 'Bearer ' + token, 'x-agent-relay-device-id': deviceId }, handshakeTimeout: 12_000,
      maxPayload: 256 * 1024, perMessageDeflate: false
    });
    let answered = true;
    socket.on('open', () => {
      attempt = 0;
      heartbeat = setInterval(() => {
        if (!answered) return socket.terminate();
        answered = false;
        if (socket.readyState === WebSocket.OPEN) socket.ping();
      }, 30_000);
      onOpen();
    });
    socket.on('pong', () => { answered = true; });
    socket.on('message', (buf, binary) => {
      if (stopped) return;
      if (binary) return socket.close(1003, 'JSON text required');
      let frame;
      try { frame = JSON.parse(buf.toString()); }
      catch { return socket.close(1007, 'Invalid JSON'); }
      if (!frame || frame.v !== 1 || typeof frame !== 'object') return socket.close(1002, 'Invalid frame');
      try { onFrame(frame); }
      catch {
        onError('LOCAL_OPERATION_FAILED');
        socket.close(1011, 'Retry later');
      }
    });
    socket.on('error', () => { if (!stopped) onError('DEVICE_STREAM_UNAVAILABLE'); });
    socket.on('close', () => {
      clearInterval(heartbeat);
      if (stopped) return;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt++, 5)) * (0.8 + Math.random() * 0.4);
      retryTimer = setTimeout(connect, delay);
    });
  }
  return {
    start: connect,
    send(frame) {
      if (!stopped && socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(frame), error => { if (error && !stopped) socket.terminate(); });
      }
    },
    close() {
      stopped = true;
      clearInterval(heartbeat);
      clearTimeout(retryTimer);
      socket?.terminate();
    }
  };
}

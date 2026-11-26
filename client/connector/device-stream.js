import WebSocket from 'ws';

export function deviceStream({ url, token, deviceId, onFrame, onError }) {
  const endpoint = new URL('/v1/device-stream', url);
  endpoint.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  let socket, retryTimer, heartbeat, stopped = false, attempt = 0;

  function connect() {
    if (stopped) return;
    const connection = new WebSocket(endpoint, {
      headers: { authorization: 'Bearer ' + token, 'x-agent-relay-device-id': deviceId }, handshakeTimeout: 12_000,
      maxPayload: 256 * 1024, perMessageDeflate: false
    });
    socket = connection;
    const link = {
      isOpen: () => !stopped && connection.readyState === WebSocket.OPEN,
      send(frame) {
        if (link.isOpen()) {
          connection.send(JSON.stringify(frame), error => { if (error) connection.terminate(); });
        }
      }
    };
    let answered = true;
    connection.on('open', () => {
      attempt = 0;
      heartbeat = setInterval(() => {
        if (!answered) return connection.terminate();
        answered = false;
        if (connection.readyState === WebSocket.OPEN) connection.ping();
      }, 30_000);
    });
    connection.on('pong', () => { answered = true; });
    connection.on('message', (buf, binary) => {
      if (stopped) return;
      if (binary) return connection.close(1003, 'JSON text required');
      let frame;
      try { frame = JSON.parse(buf.toString()); }
      catch { return connection.close(1007, 'Invalid JSON'); }
      if (!frame || frame.v !== 1 || typeof frame !== 'object') return connection.close(1002, 'Invalid frame');
      try { onFrame(frame, link); }
      catch {
        onError('LOCAL_OPERATION_FAILED');
        connection.close(1011, 'Retry later');
      }
    });
    connection.on('error', () => { if (!stopped) onError('DEVICE_STREAM_UNAVAILABLE'); });
    connection.on('close', () => {
      clearInterval(heartbeat);
      if (stopped) return;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt++, 5)) * (0.8 + Math.random() * 0.4);
      retryTimer = setTimeout(connect, delay);
    });
  }
  return {
    start: connect,
    close() {
      stopped = true;
      clearInterval(heartbeat);
      clearTimeout(retryTimer);
      socket?.terminate();
    }
  };
}

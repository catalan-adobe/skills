import { connect } from 'node:net';

/**
 * The first TCP port at or above `from` on which nothing answers on loopback. Tested by
 * connecting, not binding: listen sockets use SO_REUSEADDR, so a bind can succeed on a
 * port another process is serving.
 */
export async function freePort(from = 3001) {
  const answers = (port, host) => new Promise((resolve) => {
    const socket = connect({ port, host, timeout: 300 });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
  });
  for (let port = from; ; port += 1) {
    if (!(await answers(port, '127.0.0.1')) && !(await answers(port, '::1'))) return port;
  }
}

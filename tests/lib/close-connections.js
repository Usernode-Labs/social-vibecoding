'use strict';

// Express middleware for a test server: one request per connection.
//
// Some suites mock setTimeout and talk to a local server with fetch. Under
// Node 22 that combination stalls: with the clock mocked, a request sent
// after a response that kept its connection alive is not served until the
// server's own keep-alive timeout closes the idle connection, six real
// seconds later. tests/chat-delivery-route.test.js spent 24 of its 24.5
// seconds there and tests/chat-delivery-postgres.test.js 30 of 31.8; under
// Node 23 the same requests take milliseconds.
//
// Answering `Connection: close` on every response takes the kept-alive
// connection out of the picture. A route that names the header itself (the
// chat stream writes `Connection: keep-alive`) is overruled, which is why
// this wraps writeHead rather than only setting the header first.
function closeConnections(req, res, next) {
  const writeHead = res.writeHead;
  res.writeHead = function closing(...args) {
    for (const arg of args) {
      if (!arg || typeof arg !== 'object' || Array.isArray(arg)) continue;
      for (const name of Object.keys(arg)) {
        if (name.toLowerCase() === 'connection') delete arg[name];
      }
    }
    this.setHeader('Connection', 'close');
    return writeHead.apply(this, args);
  };
  res.setHeader('Connection', 'close');
  next();
}

module.exports = { closeConnections };

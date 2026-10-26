'use strict';
const { getPool } = require('../db/pool');
const { captureStreamAuthority } = require('../services/http-stream-access');
const log = require('../services/logger');
const MAX_BYTES = 1024 * 1024;
const SOFT_BYTES = 64 * 1024;
// Only SSE bodies are queued; ordinary HTTP responses retain Node's exact
// write/end behavior and do no authorization I/O here. New, unclassified
// platform event streams fail closed until they have a resource policy.
function privateStreamDelivery(config, { revalidateMs = 15000, authorizeTimeoutMs = 5000, batchMs = 50 } = {}) {
    const pool = getPool(config);
    return (req, res, next) => {
        if (!/^\/api\//i.test(req.path))
            return next();
        const rawWrite = res.write.bind(res), rawEnd = res.end.bind(res), rawHead = res.writeHead.bind(res);
        let eventStream = false, active = false, closed = false, ending = false, running = false;
        let scheduled = null, timer = null, queued = [], bytes = 0, inFlightBytes = 0, endCallback = null, pressured = false;
        const authorize = captureStreamAuthority(req, pool);
        const isSse = value => /^text\/event-stream(?:\s*;|\s*$)/i.test(String(value || ''));
        res.writeHead = function (...args) {
            const headers = typeof args[1] === 'string' ? args[2] : args[1];
            let type;
            if (Array.isArray(headers)) {
                for (let i = 0; i < headers.length; i += 2)
                    if (String(headers[i]).toLowerCase() === 'content-type')
                        type = headers[i + 1];
            }
            else
                for (const [key, value] of Object.entries(headers || {}))
                    if (key.toLowerCase() === 'content-type')
                        type = value;
            eventStream = isSse(type === undefined ? res.getHeader('Content-Type') : type);
            if (eventStream || active) {
                const policy = 'private, no-store, no-transform';
                res.setHeader('Cache-Control', policy);
                const index = typeof args[1] === 'string' ? 2 : 1;
                if (Array.isArray(headers)) {
                    const clean = [];
                    for (let i = 0; i < headers.length; i += 2)
                        if (String(headers[i]).toLowerCase() !== 'cache-control')
                            clean.push(headers[i], headers[i + 1]);
                    args[index] = [...clean, 'Cache-Control', policy];
                }
                else if (headers)
                    args[index] = { ...Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'cache-control')), 'Cache-Control': policy };
            }
            return rawHead(...args);
        };
        const ready = () => bytes + inFlightBytes + res.writableLength < SOFT_BYTES && !res.writableNeedDrain;
        const onRawDrain = () => { if (ready())
            pressured = false; };
        res.on('drain', onRawDrain);
        const releasePressure = () => {
            if (!closed && pressured && ready()) {
                pressured = false;
                res.emit('drain');
            }
        };
        const cleanup = () => {
            closed = true;
            if (scheduled)
                clearTimeout(scheduled);
            clearInterval(timer);
            res.removeListener('drain', onRawDrain);
            for (const item of queued)
                item.callback?.();
            queued = [];
            bytes = 0;
        };
        res.once('close', cleanup);
        res.once('finish', cleanup);
        const finish = () => {
            const cb = endCallback;
            endCallback = null;
            if (cb)
                res.once('finish', cb);
            cleanup();
            // Earlier middleware may not implement Node's end(callback) overload.
            // Preserve completion via finish and pass it no body or callback.
            try {
                rawEnd();
            }
            catch {
                res.destroy();
            }
        };
        const stop = () => {
            if (!closed)
                finish();
        };
        const allowed = async () => {
            let timeout;
            try {
                return await Promise.race([Promise.resolve().then(authorize), new Promise(resolve => {
                        timeout = setTimeout(() => resolve(false), authorizeTimeoutMs);
                        timeout.unref?.();
                    })]) === true;
            }
            finally {
                clearTimeout(timeout);
            }
        };
        const flush = async () => {
            scheduled = null;
            if (closed || running)
                return;
            running = true;
            const batch = queued;
            inFlightBytes = bytes;
            queued = [];
            bytes = 0;
            try {
                if (!(await allowed()) || closed) {
                    stop();
                    for (const item of batch)
                        item.callback?.();
                    return;
                }
                // No await between the deciding snapshot and these writes. Only this
                // batch was authorized; chunks arriving during it need a new check.
                for (const item of batch) {
                    if (closed || res.destroyed)
                        break;
                    rawWrite(item.chunk, item.callback);
                }
                if (ending && !queued.length)
                    finish();
            }
            catch {
                for (const item of batch)
                    item.callback?.();
                log.warn('private-streams', 'Stream authority unavailable');
                stop();
            }
            finally {
                inFlightBytes = 0;
                running = false;
                releasePressure();
                if (!closed && queued.length)
                    schedule();
            }
        };
        const schedule = () => {
            if (!closed && !running && !scheduled)
                scheduled = setTimeout(flush, batchMs);
        };
        const activate = () => {
            if (active)
                return true;
            if (!eventStream && !isSse(res.getHeader('Content-Type')))
                return false;
            if (!active) {
                active = true;
                timer = setInterval(schedule, revalidateMs);
                timer.unref?.();
            }
            return true;
        };
        res.write = function (chunk, encoding, callback) {
            if (!activate())
                return rawWrite(...arguments);
            if (typeof encoding === 'function') {
                callback = encoding;
                encoding = undefined;
            }
            if (closed || ending) {
                callback?.();
                return false;
            }
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
            if (bytes + inFlightBytes + data.length + res.writableLength > MAX_BYTES) {
                callback?.();
                stop();
                return false;
            }
            queued.push({ chunk: data, callback });
            bytes += data.length;
            schedule();
            if (!ready())
                pressured = true;
            return !pressured;
        };
        res.end = function (chunk, encoding, callback) {
            if (!activate())
                return rawEnd(...arguments);
            if (typeof chunk === 'function') {
                callback = chunk;
                chunk = undefined;
            }
            else if (typeof encoding === 'function') {
                callback = encoding;
                encoding = undefined;
            }
            if (closed) {
                callback?.();
                return res;
            }
            if (ending) {
                if (callback)
                    res.once('finish', callback);
                return res;
            }
            if (chunk != null)
                res.write(chunk, encoding);
            if (closed) {
                callback?.();
                return res;
            }
            ending = true;
            endCallback = callback;
            schedule();
            return res;
        };
        next();
    };
}
module.exports = { privateStreamDelivery };

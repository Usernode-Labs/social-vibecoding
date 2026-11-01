'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('minio');
const media = require('../src/services/media-store');

// Use a local disposable MinIO endpoint only. The normal unit run needs no
// network storage; the PostgreSQL suite separately exercises the real locks.
test('media store against versioned MinIO: immutable retry, listing and partial reads', {
  skip: !process.env.TEST_MEDIA_STORAGE_ENDPOINT && 'set TEST_MEDIA_STORAGE_ENDPOINT for local MinIO',
}, async () => {
  const endpoint = new URL(process.env.TEST_MEDIA_STORAGE_ENDPOINT);
  assert.ok(['localhost', '127.0.0.1', 'usernode-minio'].includes(endpoint.hostname), 'local test storage only');
  const config = {
    mediaStorageEndpoint: endpoint.origin,
    mediaStorageBucket: 'media-test-' + crypto.randomBytes(6).toString('hex'),
    mediaStorageAccessKey: process.env.TEST_MEDIA_STORAGE_ACCESS_KEY || 'media-test',
    mediaStorageSecretKey: process.env.TEST_MEDIA_STORAGE_SECRET_KEY || 'media-test-only',
  };
  const client = new Client({ endPoint: endpoint.hostname, port: Number(endpoint.port) || 9000,
    useSSL: endpoint.protocol === 'https:', accessKey: config.mediaStorageAccessKey, secretKey: config.mediaStorageSecretKey });
  const bucket = config.mediaStorageBucket;
  await client.makeBucket(bucket);
  try {
    await client.setBucketVersioning(bucket, { Status: 'Enabled' });
    const store = media.createMediaStore(config);
    const data = Buffer.from('an immutable clip');
    // PostgreSQL transaction behavior is tested in media-store-postgres.
    const tx = { query: async () => {} };
    const key = await media.put(tx, store, data, 'video/webm');
    assert.equal(await media.put(tx, store, data, 'video/webm'), key);
    const versions = [];
    for await (const v of client.listObjects(bucket, '', true, { IncludeVersion: true })) versions.push(v);
    assert.equal(versions.length, 1, 'retry creates no extra billable version');
    assert.deepEqual(await media.bytes(store, { object_key: key }), data);
    const chunks = [];
    for await (const chunk of await media.stream(store, key, { start: 3, end: 11 })) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), data.subarray(3, 12).toString());
    const listed = [];
    for await (const file of store.objects(media.PREFIX)) listed.push(file);
    assert.equal(listed.length, 1); assert.equal(listed[0].name, key);
    assert.equal((await store.statObject(key)).size, data.length);
    await store.removeObject(key);
    assert.equal(await store.statObject(key), null);
  } finally {
    // Remove all versions and delete markers before dropping our test bucket.
    const versions = [];
    for await (const v of client.listObjects(bucket, '', true, { IncludeVersion: true })) versions.push(v);
    for (const v of versions) await client.removeObject(bucket, v.name, { versionId: v.versionId });
    await client.removeBucket(bucket);
  }
});

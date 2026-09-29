// Completed epoch responses belong to the device, not a component lifetime.
// No TTL: the full response is retained by chain, wallet and epoch.
export const epochCacheKey = (chainId, wallet, epoch) => JSON.stringify([chainId, wallet, epoch]);

export function createEpochCache(idb = globalThis.indexedDB) {
  let opening;
  function open() {
    if (!idb) return Promise.resolve(null);
    if (!opening) opening = new Promise((resolve) => {
      const request = idb.open('homeroom-staking-epochs', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('epochs');
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); opening = null; };
        resolve(db);
      };
      request.onerror = request.onblocked = () => { opening = null; resolve(null); };
    });
    return opening;
  }
  return {
    async get(chainId, wallet, epoch) {
      try {
        const db = await open();
        if (!db) return null;
        return await new Promise((resolve) => {
          const tx = db.transaction('epochs', 'readonly');
          const request = tx.objectStore('epochs').get(epochCacheKey(chainId, wallet, epoch));
          request.onsuccess = () => {
            const value = request.result;
            resolve(value?.complete === true && value.chainId === chainId
              && value.wallet === wallet && value.epoch === epoch ? value : null);
          };
          request.onerror = tx.onabort = () => resolve(null);
        });
      } catch { return null; }
    },
    async put(response) {
      if (response?.complete !== true) return false;
      try {
        const db = await open();
        if (!db) return false;
        return await new Promise((resolve) => {
          const tx = db.transaction('epochs', 'readwrite');
          tx.objectStore('epochs').put(response,
            epochCacheKey(response.chainId, response.wallet, response.epoch));
          tx.oncomplete = () => resolve(true);
          tx.onerror = tx.onabort = () => resolve(false);
        });
      } catch { return false; }
    },
  };
}

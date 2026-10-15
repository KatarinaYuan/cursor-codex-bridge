import fs from 'node:fs/promises';

const busy = message => Object.assign(new Error(message), { code: -32002 });

/** Stop admitting turns before draining their locks; disk activity alone has a send/stop race. */
export function createMaintenanceGate({ file, locks, isBusy, drainTimeoutMs = 2000 }) {
  let requested = false;
  async function exists() {
    if (!file) return false;
    try { await fs.access(file); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  return {
    async assertOpen() {
      if (await exists()) throw busy('Cursor bridge is being maintained; reconnect after the operation completes');
      // A failed installer removes its marker, allowing the old process to recover.
      requested = false;
    },
    async quiesce() {
      if (!file || !await exists()) throw busy('Maintenance requires the dedicated installer marker');
      requested = true;
      let timer;
      try {
        await Promise.race([
          Promise.allSettled([...locks()]),
          new Promise((_, reject) => { timer = setTimeout(() => reject(busy('Cursor bridge requests are still pending; retry after they finish')), drainTimeoutMs); }),
        ]);
        if (isBusy()) throw busy('Cursor bridge has an active turn; wait for it to finish');
        return { idle: true, protocol: 1 };
      } catch (error) { requested = false; throw error; }
      finally { clearTimeout(timer); }
    },
    get requested() { return requested; },
  };
}

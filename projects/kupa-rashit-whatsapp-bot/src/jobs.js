// Runs long WhatsApp jobs (sync, unblock, …) one at a time and keeps a short log
// that the admin panel shows live.
const queue = [];
let current = null;
const log = [];

export function addLog(line) {
  const entry = `${new Date().toLocaleTimeString("he-IL", { hour12: false })}  ${line}`;
  console.log(line);
  log.push(entry);
  if (log.length > 300) log.splice(0, log.length - 300);
}

/** Queues a job. Jobs with the same key are not queued twice. */
export function enqueue(key, label, fn) {
  if (current?.key === key || queue.some((j) => j.key === key)) return false;
  queue.push({ key, label, fn });
  run();
  return true;
}

async function run() {
  if (current) return;
  while (queue.length) {
    current = queue.shift();
    addLog(`▶ ${current.label}`);
    try {
      await current.fn();
    } catch (e) {
      addLog(`✖ ${current.label}: ${e.message}`);
      console.error(e);
    }
    current = null;
  }
}

export const jobsStatus = () => ({
  current: current?.label ?? null,
  queued: queue.map((j) => j.label),
  log: log.slice(-120),
});

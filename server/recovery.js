/** A status needs recovery when the server is down (null) or returns a 5xx. */
export function isBadStatus(status) {
  return status === null || status >= 500;
}

/**
 * Drive recovery for one project: probe → clean restart → (if still bad) ask
 * Claude to fix → restart again → probe. Bounded to a single fix cycle. The
 * `driver` abstracts process control + probing so this stays pure & testable.
 *
 * @returns {Promise<{outcome:string, status:number|null}>}
 */
export async function recoverProject(driver, id, { url } = {}) {
  const target = url || driver.origin(id);
  driver.emit('recovery:start', { id, url: target });

  const end = (outcome, status) => {
    driver.emit('recovery:end', { id, url: target, outcome, status });
    return { outcome, status };
  };

  let status = await driver.probe(target);
  if (!isBadStatus(status)) return end('healthy', status);

  // 1) Clean restart.
  driver.emit('recovery:step', { id, step: 'restart' });
  await driver.restart(id);
  status = await driver.probe(target);
  if (!isBadStatus(status)) return end('recovered-by-restart', status);

  // 2) Escalate to a Claude code fix (once), then restart again.
  driver.emit('recovery:step', { id, step: 'fix' });
  await driver.runFix(id, driver.errorLog(id));
  driver.emit('recovery:step', { id, step: 'restart-after-fix' });
  await driver.restart(id);
  status = await driver.probe(target);
  if (!isBadStatus(status)) return end('recovered-by-fix', status);

  return end('failed', status);
}

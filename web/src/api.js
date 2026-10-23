async function request(path, opts) {
  const res = await fetch(path, opts);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) throw new Error((body && body.error) || `Request failed (${res.status})`);
  return body;
}

const post = (path, data) =>
  request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data ?? {}) });

export const getRuns = () => request('/api/runs');
export const getRun = (id) => request(`/api/runs/${encodeURIComponent(id)}`);
export const respond = (id, action, text) => post(`/api/runs/${encodeURIComponent(id)}/respond`, { action, text });
export const stopRun = (id) => post(`/api/runs/${encodeURIComponent(id)}/stop`, {});

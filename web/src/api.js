async function request(path, opts) {
  const res = await fetch(path, opts);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const err = new Error((body && body.error) || `Request failed (${res.status})`);
    err.body = body;
    throw err;
  }
  return body;
}

const post = (path, data) =>
  request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data ?? {}) });

export const getRuns = () => request('/api/runs');
export const getRun = (id) => request(`/api/runs/${encodeURIComponent(id)}`);
export const respond = (id, action, text) => post(`/api/runs/${encodeURIComponent(id)}/respond`, { action, text });
export const stopRun = (id) => post(`/api/runs/${encodeURIComponent(id)}/stop`, {});

const send = (method, path, data) =>
  request(path, { method, headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });

export const getWorkflow = () => request('/api/workflow');
export const putDraft = (workflow) => send('PUT', '/api/workflow/draft', { workflow });
export const discardDraft = () => send('DELETE', '/api/workflow/draft');
export const publishDraft = () => post('/api/workflow/publish', {});
export const getVersions = () => request('/api/workflow/versions');
export const loadVersion = (v) => post(`/api/workflow/versions/${encodeURIComponent(v)}/load`, {});

// Calls for the Accounts page (/api/accounts*, contract C11). Errors carry the server's plain-words message.
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
    err.status = res.status;
    throw err;
  }
  return body;
}

const post = (path, data) =>
  request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

export const getAccounts = () => request('/api/accounts');
export const switchAccount = (name) => post('/api/accounts/use', { name });
export const refreshUsage = () => post('/api/accounts/refresh', {});
export const addAccount = (name, email) => post('/api/accounts/add', email ? { name, email } : { name });
export const sendCode = (code) => post('/api/accounts/add/code', { code });
export const cancelSignIn = () => post('/api/accounts/add/cancel', {});

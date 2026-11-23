// Calls for the Accounts page (/api/accounts*, contract C11). Errors carry the server's plain-words message and `status`.
import { post, request } from '../api.js';

export const getAccounts = () => request('/api/accounts');
export const switchAccount = (name) => post('/api/accounts/use', { name });
export const refreshUsage = () => post('/api/accounts/refresh', {});
export const addAccount = (name, email) => post('/api/accounts/add', email ? { name, email } : { name });
export const sendCode = (code) => post('/api/accounts/add/code', { code });
export const cancelSignIn = () => post('/api/accounts/add/cancel', {});

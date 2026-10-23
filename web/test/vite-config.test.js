// @vitest-environment node
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import config from '../vite.config.js';

describe('dev proxy', () => {
  it('rewrites Host and drops Origin for /api, /mcp and /hook', () => {
    expect(Object.keys(config.server.proxy).sort()).toEqual(['/api', '/hook', '/mcp']);
    for (const opts of Object.values(config.server.proxy)) {
      expect(opts.target).toBe('http://127.0.0.1:4747');
      expect(opts.changeOrigin).toBe(true);
      const proxy = new EventEmitter();
      opts.configure(proxy);
      const removed = [];
      proxy.emit('proxyReq', { removeHeader: (h) => removed.push(h) });
      expect(removed).toEqual(['origin']);
    }
  });
});

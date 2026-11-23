// EXPLOIT (white-hat, am-affect-pro): the Ledger stores change-worthy commands for 2000 chars, "with passwords, tokens,
// keys and user:pass@ URLs masked before anything is stored" (README). Common credential forms pass redact() unmasked
// and land in the changes table and GET /api/runs/:id/ledger (shown on the Ledger tab, e.g. on a shared screen).
// Secure behaviour asserted: none of these secrets is stored or served.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { createHooks } from '../src/hooks.js';
import { classifyChanges } from '../src/ledger.js';
import { tmp } from './helpers.js';

const S = 'Hunter2pass9';
const CASES = {
  'curl -u user:pass': `curl -u admin:${S} https://ci.example.com/job/x/build && git push origin main`,
  'curl --user user:pass': `curl --user admin:${S} -X POST https://ci.example.com/deploy && git push origin main`,
  'sshpass -p': `sshpass -p '${S}' ssh percy 'docker restart api'`,
  'mysql -p<pw>': `mysqldump -uroot -p${S} app > app.sql && git commit -am "db dump"`,
  'docker login -p': `docker login -u bot -p ${S} registry.example.com && docker restart web`,
  'PowerShell $dbPassword = ...': `$dbPassword = '${S}'; pg_dump -h db -U app app > before.sql`,
  'X-Api-Key header': `curl -H "X-Api-Key: ${S}" -X POST https://deploy.example.com/hook && git push origin main`,
  'connection string Pwd=': `sqlcmd -S db -Q "BACKUP DATABASE app" -C "Server=db;Uid=sa;Pwd=${S};" && git commit -am backup`,
};

for (const [name, command] of Object.entries(CASES)) {
  test(`ledger masks the secret in: ${name}`, () => {
    const store = openStore(tmp('am-wh-redact'));
    const hooks = createHooks(store, { projectsDir: tmp('am-proj'), port: 4747, defer: (fn) => fn(), clock: () => Date.now() });
    const { run } = store.startRun({ title: 'R' });
    store.linkSession('cs', run.id);
    hooks.handle({ session_id: 'cs', cwd: '/x', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'u1' });
    const rows = store.changesOf(run.id);
    assert.equal(rows.length, 1, 'the command is a change candidate (recorded)');
    const served = JSON.stringify(classifyChanges(rows));
    store.close();
    assert.ok(!rows[0].input.includes(S), `stored: ${rows[0].input}`);
    assert.ok(!served.includes(S), 'served by the ledger endpoint');
  });
}
// (The old activity.summary being stored unredacted is untouched by this change: backlog item #246.)

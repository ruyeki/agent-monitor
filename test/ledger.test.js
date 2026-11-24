import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isChangeCandidate, redact, classifyChanges } from '../src/ledger.js';

let n = 0;
const row = (input, result = null, outcome = 'ok', extra = {}) => {
  n++;
  return { id: n, at: 1000 + n, agentId: 'main:s1', tool: 'Bash', toolUseId: `tu${n}`, input, result, outcome, ...extra };
};
const one = (input, result, outcome) => classifyChanges([row(input, result, outcome)]).items;
const fakeKey = (prefix, len) => prefix + 'a1B2c3D4e5'.repeat(Math.ceil(len / 10)).slice(0, len);

const COMMIT_OUT = '[feat/x 274eae5] Answer waiting runs in a Decision Inbox\n 4 files changed, 169 insertions(+), 120 deletions(-)\n';
const PUSH_OUT = 'To github.com:ruyeki/agent-monitor.git\n   4ec2e9f..3a44b3a  main -> main\n';

// ---------- isChangeCandidate ----------

test('candidate: git commit/push/merge, with cd, -C and chains', () => {
  assert.equal(isChangeCandidate('Bash', { command: 'git commit -m "x"' }), true);
  assert.equal(isChangeCandidate('Bash', { command: 'cd /repo && git add -A && git commit -m x' }), true);
  assert.equal(isChangeCandidate('Bash', { command: 'git -C /repo push origin main' }), true);
  assert.equal(isChangeCandidate('PowerShell', { command: 'git merge feat/x' }), true);
  assert.equal(isChangeCandidate('Bash', 'git push --force-with-lease'), true);
});

test('candidate: gh pr create/merge, worktree, restarts, DB', () => {
  assert.equal(isChangeCandidate('Bash', { command: 'gh pr create --title t --body b' }), true);
  assert.equal(isChangeCandidate('Bash', { command: 'gh pr merge 12 --squash' }), true);
  assert.equal(isChangeCandidate('Bash', { command: 'git worktree add C:\\wt\\x -b feat/x' }), true);
  assert.equal(isChangeCandidate('Bash', { command: 'pm2 restart agent-monitor' }), true);
  assert.equal(isChangeCandidate('Bash', { command: 'cp data/agent-monitor.db data/agent-monitor.db.bak' }), true);
  assert.equal(isChangeCandidate('Bash', { command: 'pg_dump -U u nike > /tmp/nike.sql' }), true);
  assert.equal(isChangeCandidate('Bash', { command: 'flask db upgrade' }), true);
});

test('candidate: command arrays and string input', () => {
  assert.equal(isChangeCandidate('Bash', { command: ['bash', '-lc', 'git push origin main'] }), true);
  assert.equal(isChangeCandidate('Bash', { command: ['git', 'status'] }), false);
  assert.equal(isChangeCandidate('Bash', '{"command":"git push"}'), true);
});

test('candidate: hephaestus update_task only with a status', () => {
  assert.equal(isChangeCandidate('mcp__hephaestus__update_task', { task_id: 2288, status: 'Done' }), true);
  assert.equal(isChangeCandidate('mcp__hephaestus__update_task', '{"task_id":2288,"status":"In Progress","descr'), true);
  assert.equal(isChangeCandidate('mcp__hephaestus__update_task', { task_id: 2288, description: 'note' }), false);
  assert.equal(isChangeCandidate('mcp__hephaestus__get_task', { task_id: 2288, status: 'Done' }), false);
});

test('candidate: read-only and look-alike commands are not candidates', () => {
  for (const c of [
    'git status', 'git log --oneline -5', 'git diff HEAD~1', 'git show abc1234', 'git fetch origin',
    'git push --dry-run origin main', 'git push -n', 'git commit --dry-run', 'gh pr view 12', 'gh pr list', 'gh pr diff 12',
    'grep "git push" notes.md', 'echo "git commit"', '# git push later', 'cat README.md', 'ls -la',
    'echo "pm2 restart x"', 'cp a.txt b.txt', 'cp data.db.bak data.db', 'alembic history', 'systemctl status nginx',
  ]) {
    assert.equal(isChangeCandidate('Bash', { command: c }), false, c);
  }
  assert.equal(isChangeCandidate('Read', { file_path: 'git push' }), false);
  assert.equal(isChangeCandidate('Bash', null), false);
});

test('candidate: heredoc commit message that mentions push is still one commit, not a push', () => {
  const cmd = 'git commit -m "$(cat <<\'EOF\'\nFix the thing\n\nthen git push later\nEOF\n)"';
  const items = one(cmd, COMMIT_OUT);
  assert.deepEqual(items.map((i) => i.kind), ['commit']);
});

// ---------- redact ----------

test('redact: env assignments keep the name, mask the value', () => {
  assert.equal(redact('PGPASSWORD=hunter2 psql -h db'), 'PGPASSWORD=*** psql -h db');
  assert.equal(redact('DB_PASSWORD="p w d" ./run'), 'DB_PASSWORD=*** ./run');
  assert.equal(redact('GITHUB_TOKEN=abc123 gh pr list'), 'GITHUB_TOKEN=*** gh pr list');
  assert.equal(redact('export APP_SECRET=s3cr3t; echo ok'), 'export APP_SECRET=***; echo ok');
  assert.equal(redact("$env:PGPASSWORD = 'x y'; psql"), '$env:PGPASSWORD = ***; psql');
});

test('redact: connection strings and URLs', () => {
  assert.equal(redact('host=db user=u password=s3cret dbname=n'), 'host=db user=u password=*** dbname=n');
  assert.equal(redact('postgresql://migrator:Pa55word@percy:5432/nike'), 'postgresql://migrator:***@percy:5432/nike');
  assert.equal(redact('git remote add o https://x-access-token:abc@github.com/o/r.git'), 'git remote add o https://x-access-token:***@github.com/o/r.git');
  assert.equal(redact('git@github.com:ruyeki/agent-monitor.git'), 'git@github.com:ruyeki/agent-monitor.git');
});

test('redact: token-shaped keys and Authorization headers', () => {
  const ghp = fakeKey('ghp_', 36);
  const pat = fakeKey('github_pat_', 40);
  const sk = fakeKey('sk-', 40);
  const slack = fakeKey('xoxb-', 30);
  for (const k of [ghp, fakeKey('gho_', 36), pat, sk, slack]) {
    const out = redact(`curl -s -d "key=${k}" x ${k}`);
    assert.ok(!out.includes(k), out);
    assert.ok(out.includes('***'));
  }
  assert.equal(redact('curl -H "Authorization: Bearer abc.def-123" https://api'), 'curl -H "Authorization: Bearer ***" https://api');
  assert.equal(redact('Bearer ' + 'Z9y8X7w6V5u4T3s2R1'), 'Bearer ***');
});

test('redact: JSON and flags, references stay readable', () => {
  assert.equal(redact('{"user":"a","password":"x y","n":1}'), '{"user":"a","password":"***","n":1}');
  assert.equal(redact('tool --token abc123 --name x'), 'tool --token *** --name x');
  assert.equal(redact('PGPASSWORD=$PGPASSWORD psql'), 'PGPASSWORD=$PGPASSWORD psql');
});

test('redact: ordinary text is untouched', () => {
  for (const t of [
    'git commit -m "Fix password reset page"', 'max_tokens=500 node run.js', 'ls -la /home/ruyeki', 'The bearer of news',
    'https://github.com/ruyeki/agent-monitor.git', 'sk-short', 'echo done',
  ]) assert.equal(redact(t), t);
  assert.equal(redact(null), '');
});

// ---------- classifyChanges: git ----------

test('commit: parses hash, subject, files and lines from git output', () => {
  const [it] = one('git commit -m "x"', COMMIT_OUT);
  assert.equal(it.kind, 'commit');
  assert.equal(it.category, 'code');
  assert.equal(it.title, 'Committed 274eae5 Answer waiting runs in a Decision Inbox');
  assert.deepEqual(it.chips, ['git \u00b7 feat/x', '+169', '\u2212120', '4 files']);
  assert.deepEqual(it.stats, { files: 4, insertions: 169, deletions: 120 });
  assert.equal(it.tag, 'reversible');
  assert.equal(it.tagLabel, 'Can change back');
});

test('commit: single file, only insertions, root commit', () => {
  const [it] = one('git commit -m first', '[main (root-commit) abcdef1] first\n 1 file changed, 3 insertions(+)\n');
  assert.equal(it.title, 'Committed abcdef1 first');
  assert.deepEqual(it.stats, { files: 1, insertions: 3, deletions: 0 });
  assert.deepEqual(it.chips, ['git \u00b7 main', '+3', '\u22120', '1 file']);
});

test('commit without a result falls back to the -m message', () => {
  const [it] = one('git commit -m "Add the ledger core"', null, null);
  assert.equal(it.title, 'Committed Add the ledger core');
  assert.equal(it.stats, null);
});

test('commit: heredoc message form and cd prefix', () => {
  const cmd = 'cd C:/wt/x && git add -A && git commit -m "$(cat <<\'EOF\'\nAdd ledger\n\nBody\nCo-Authored-By: Claude\nEOF\n)"';
  const items = one(cmd, '[feat/y 0123abc] Add ledger\n 2 files changed, 10 insertions(+), 1 deletion(-)\n');
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Committed 0123abc Add ledger');
  assert.equal(items[0].stats.deletions, 1);
});

test('commit: PowerShell here-string message', () => {
  const cmd = "git commit -m @'\nAdd ledger\n\ngit push is next\n'@";
  const items = one(cmd, '[feat/y 0123abc] Add ledger\n 1 file changed, 1 insertion(+)\n');
  assert.deepEqual(items.map((i) => i.kind), ['commit']);
});

test('push: parses refs, remote, GitHub title, permanent tag', () => {
  const [it] = one('git -C /repo push origin main', PUSH_OUT);
  assert.equal(it.kind, 'push');
  assert.equal(it.title, 'Pushed main to GitHub');
  assert.deepEqual(it.chips, ['ruyeki/agent-monitor', '4ec2e9f \u2192 3a44b3a']);
  assert.equal(it.tag, 'permanent');
  assert.equal(it.tagLabel, "Can't be undone");
});

test('push: new branch and https remote, force push stays permanent', () => {
  const out = 'To https://github.com/ruyeki/agent-monitor.git\n * [new branch]      feat/x -> feat/x\n';
  const [a] = one('git push -u origin feat/x', out);
  assert.equal(a.title, 'Pushed feat/x to GitHub');
  assert.match(a.detail, /New branch/);
  const [b] = one('git push --force origin main', 'To github.com:o/r.git\n + 1111111...2222222 main -> main (forced update)\n');
  assert.equal(b.title, 'Force-pushed main to GitHub');
  assert.equal(b.tag, 'permanent');
  assert.match(b.detail, /Force push/);
});

test('push: branch from the command when there is no result; up-to-date push is not a change', () => {
  const [it] = one('git push origin HEAD:release', null, null);
  assert.equal(it.title, 'Pushed release to GitHub');
  assert.deepEqual(one('git push', 'Everything up-to-date\n'), []);
});

test('push makes earlier commits Pushed and counts them', () => {
  const items = classifyChanges([
    row('git commit -m a', '[m 1111111] a\n 1 file changed, 1 insertion(+)\n'),
    row('git commit -m b', '[m 2222222] b\n 1 file changed, 2 insertions(+)\n'),
    row('git push origin main', PUSH_OUT),
    row('git commit -m c', '[m 3333333] c\n 1 file changed, 1 insertion(+)\n'),
  ]).items;
  assert.deepEqual(items.map((i) => i.kind), ['commit', 'push', 'commit', 'commit']);
  assert.deepEqual(items.map((i) => i.tagLabel), ['Can change back', "Can't be undone", 'Pushed', 'Pushed']);
  assert.equal(items[2].tag, 'info');
  assert.match(items[1].detail, /Carries 2 commits/);
});

test('a failed push does not make commits Pushed and is skipped', () => {
  const { items } = classifyChanges([
    row('git commit -m a', '[m 1111111] a\n 1 file changed, 1 insertion(+)\n'),
    row('git push origin main', ' ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs\n'),
    row('git push origin main', 'fatal: unable to access', 'error'),
  ]);
  assert.deepEqual(items.map((i) => i.kind), ['commit']);
  assert.equal(items[0].tagLabel, 'Can change back');
});

test('commit && push in one call where the push failed keeps the commit', () => {
  const out = '[m 1111111] a\n 1 file changed, 1 insertion(+)\nerror: failed to push some refs\n';
  const items = one('git commit -m a && git push', out, 'error');
  assert.deepEqual(items.map((i) => i.kind), ['commit']);
});

test('commit && push in one call gives two items, newest (push) first', () => {
  const out = `${COMMIT_OUT}${PUSH_OUT}`;
  const items = one('git commit -am x && git push origin main', out);
  assert.deepEqual(items.map((i) => i.kind), ['push', 'commit']);
  assert.equal(items[1].tagLabel, 'Pushed');
  assert.notEqual(items[0].id, items[1].id);
});

test('merge is reversible; failed merge skipped; abort ignored', () => {
  const [m] = one('git merge --no-ff feat/x', 'Merge made by the ort strategy.\n');
  assert.equal(m.title, 'Merged feat/x');
  assert.equal(m.tag, 'reversible');
  assert.deepEqual(one('git merge feat/x', 'error: Your local changes would be overwritten', 'ok'), []);
  assert.deepEqual(one('git merge --abort'), []);
});

test('gh pr create is reversible; gh pr merge is permanent', () => {
  const [c] = one('gh pr create --title "Ledger core" --body x', 'https://github.com/ruyeki/agent-monitor/pull/57\n');
  assert.equal(c.title, 'Opened pull request #57');
  assert.equal(c.detail, 'Ledger core');
  assert.equal(c.tagLabel, 'Can change back');
  const [m] = one('gh pr merge 57 --squash', '\u2713 Squashed and merged pull request #57\n');
  assert.equal(m.title, 'Merged pull request #57');
  assert.equal(m.tag, 'permanent');
  assert.equal(m.tagLabel, "Can't be undone");
});

test('worktree add is reversible, remove is Cleaned up', () => {
  const [a] = one('git worktree add C:\\wt\\agent-monitor-affect -b feat/affect', 'Preparing worktree');
  assert.equal(a.title, 'Created a worktree');
  assert.equal(a.category, 'machines');
  assert.ok(a.chips.includes('C:\\wt\\agent-monitor-affect'));
  assert.equal(a.tagLabel, 'Can change back');
  const [r] = one('git worktree remove C:\\wt\\agent-monitor-affect --force');
  assert.equal(r.title, 'Removed a worktree');
  assert.equal(r.tag, 'info');
  assert.equal(r.tagLabel, 'Cleaned up');
});

// ---------- machines / tasks ----------

test('db backup then upgrade: upgrade is Backup kept and names the file', () => {
  const { items } = classifyChanges([
    row('cp data/agent-monitor.db data/agent-monitor.db.bak-affect-20261122'),
    row('node src/cli.js db upgrade', 'schema v3 -> v4\n'),
  ]);
  assert.deepEqual(items.map((i) => i.title), ['Upgraded the database', 'Backed up the database']);
  assert.equal(items[1].tagLabel, 'Backup kept');
  assert.equal(items[0].tag, 'backup');
  assert.equal(items[0].tagLabel, 'Backup kept');
  assert.match(items[0].detail, /agent-monitor\.db\.bak-affect-20261122/);
  assert.ok(items[0].chips.includes('schema v3 \u2192 v4'));
});

test('db upgrade without an earlier backup is permanent, and later backup does not help', () => {
  const { items, summary } = classifyChanges([
    row('alembic upgrade head', 'Running upgrade 1 -> 2'),
    row('pg_dump -U u -f /tmp/after.sql nike'),
  ]);
  const up = items.find((i) => i.kind === 'db-upgrade');
  assert.equal(up.tag, 'permanent');
  assert.equal(up.tagLabel, "Can't be undone");
  assert.equal(summary.permanent.length, 1);
  assert.equal(summary.permanent[0].title, 'Upgraded the database');
});

test('backup forms: sqlite3 .backup, Copy-Item, pg_dump redirect; restore is not a backup', () => {
  assert.equal(one('sqlite3 agent-monitor.db ".backup agent-monitor.db.bak"')[0].file, 'agent-monitor.db.bak');
  assert.equal(one('Copy-Item -Path data\\a.db -Destination data\\a.db.bak')[0].kind, 'db-backup');
  assert.equal(one('pg_dump nike > /tmp/nike.sql')[0].file, '/tmp/nike.sql');
  assert.deepEqual(one('cp data/a.db.bak data/a.db'), []);
});

test('server restarts: pm2, systemctl, docker, screen, kill + start', () => {
  const t = (c) => one(c)[0];
  assert.equal(t('pm2 restart agent-monitor').title, 'Restarted the Agent Monitor server');
  assert.equal(t('pm2 restart orca-worker').title, 'Restarted orca-worker');
  assert.equal(t('sudo systemctl restart nginx').title, 'Restarted nginx');
  assert.equal(t('docker restart pg-test').title, 'Restarted pg-test');
  assert.equal(t('screen -dmS ruyeki-veritas-backend uvicorn app:app --port 8152').kind, 'restart');
  const k = t('taskkill /PID 44124 /F && node src/cli.js serve --port 4747');
  assert.equal(k.title, 'Restarted the Agent Monitor server');
  assert.equal(k.tag, 'info');
  assert.equal(k.tagLabel, 'Ran once');
  assert.deepEqual(one('kill 1234'), []);
});

test('hephaestus update_task: status chip, reversible, skips errors and no-status', () => {
  const mk = (input, outcome = 'ok') => row(input, null, outcome, { tool: 'mcp__hephaestus__update_task' });
  const { items } = classifyChanges([
    mk('{"task_id":2288,"status":"Done"}'),
    mk('{"task_id":2289,"description":"note"}'),
    mk('{"task_id":2290,"status":"Done"}', 'error'),
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Set Hephaestus #2288 status');
  assert.deepEqual(items[0].chips, ['Hephaestus', 'Done']);
  assert.equal(items[0].category, 'tasks');
  assert.equal(items[0].tagLabel, 'Can change back');
});

// ---------- command shapes ----------

test('percy ssh_run heredoc: remote commands inside are found, host chip is percy', () => {
  const cmd = "python3 ~/.claude/tools/percy/ssh_run.py percy - <<'EOF'\ncd ~/multi-task-app && git pull\nscreen -dmS task-app npm start\ntmux ls\nEOF";
  const items = one(cmd);
  assert.deepEqual(items.map((i) => i.kind), ['restart']);
  assert.ok(items[0].chips.includes('percy'));
});

test('percy heredoc collapsed to a 120-char summary still works', () => {
  const cmd = "python3 ~/.claude/tools/percy/ssh_run.py percy - <<'EOF' cd ~/x && pm2 restart agent-monitor EOF";
  assert.equal(one(cmd)[0].title, 'Restarted the Agent Monitor server');
});

test('truncated summaries: cut mid-command and cut inside a quote', () => {
  assert.equal(one('cd C:/wt/x && git commit -m "Add the ledger core and wire it into the sto')[0].kind, 'commit');
  assert.equal(one('git -C C:/wt/x push origin fe')[0].title, 'Pushed fe to GitHub');
  assert.deepEqual(one('git commit -m "$(cat <<\'EOF\' Add ledger Body EOF )"')[0].kind, 'commit');
  assert.deepEqual(one('git sta'), []);
});

test('multi-line script with several actions, comments and continuations', () => {
  const cmd = [
    '#!/bin/bash', 'set -e', '# git push is the last step', 'cd /repo', 'git add -A', 'git commit -m "x" \\', '  --no-verify', 'git push origin main',
  ].join('\n');
  const items = one(cmd, `${COMMIT_OUT}${PUSH_OUT}`);
  assert.deepEqual(items.map((i) => i.kind), ['push', 'commit']);
});

test('quoted wrappers: ssh "..." and bash -c "..."', () => {
  assert.equal(one('ssh percy "cd x && git push origin main"')[0].kind, 'push');
  assert.equal(one("bash -c 'gh pr merge 3'")[0].kind, 'pr-merge');
});

test('negatives never produce items, even with results', () => {
  const cmds = [
    'git status', 'git log -3', 'git diff', 'git show HEAD', 'git fetch', 'git push --dry-run', 'gh pr view 3', 'gh pr list', 'gh pr diff 3',
    'grep "git push" run.sh', 'echo "git commit -m x"', "cat <<'EOF' > s.sh\ngit push\nEOF", '# git commit', 'npm test',
  ];
  assert.deepEqual(classifyChanges(cmds.map((c) => row(c, 'ok\n'))).items, []);
});

test('failed calls: outcome error and fatal/error result are skipped', () => {
  assert.deepEqual(one('git commit -m x', 'fatal: not a git repository', 'error'), []);
  assert.deepEqual(one('git commit -m x', 'error: pathspec did not match', 'ok'), []);
  assert.deepEqual(one('pm2 restart x', 'fatal: nope'), []);
});

// ---------- ordering, summary ----------

test('items come back newest first even when rows arrive in any order', () => {
  const a = row('git commit -m a', '[m 1111111] a\n 1 file changed, 1 insertion(+)\n');
  const b = row('pm2 restart x');
  const c = row('git push origin main', PUSH_OUT);
  const { items } = classifyChanges([c, a, b]);
  assert.deepEqual(items.map((i) => i.kind), ['push', 'restart', 'commit']);
  assert.ok(items[0].at > items[1].at && items[1].at > items[2].at);
  assert.equal(items[2].tagLabel, 'Pushed');
});

test('summary counts and the permanent list', () => {
  const heph = row('{"task_id":2288,"status":"Done"}', null, 'ok', { tool: 'mcp__hephaestus__update_task' });
  const { items, summary } = classifyChanges([
    row('git commit -m a', '[m 1111111] a\n 2 files changed, 10 insertions(+), 2 deletions(-)\n'),
    row('git commit -m b', '[m 2222222] b\n 1 file changed, 5 insertions(+)\n'),
    row('git push origin main', PUSH_OUT),
    row('gh pr merge 9'),
    row('pm2 restart agent-monitor'),
    heph,
    row('git status'),
  ]);
  assert.equal(summary.total, items.length);
  assert.deepEqual(
    { c: summary.commits, f: summary.files, i: summary.insertions, d: summary.deletions, p: summary.pushes, t: summary.tasks, r: summary.restarts, total: summary.total },
    { c: 2, f: 3, i: 15, d: 2, p: 1, t: 1, r: 1, total: 6 },
  );
  assert.deepEqual(summary.permanent.map((p) => p.title), ['Merged pull request #9', 'Pushed main to GitHub']);
});

test('empty and junk input', () => {
  assert.deepEqual(classifyChanges([]), { items: [], summary: { commits: 0, commitsWithStats: 0, files: 0, insertions: 0, deletions: 0, pushes: 0, prs: 0, merges: 0, worktrees: 0, databases: 0, tasks: 0, restarts: 0, total: 0, permanent: [] } });
  assert.deepEqual(classifyChanges(null).items, []);
  assert.deepEqual(classifyChanges([{ id: 1, at: 1, tool: 'Read', input: 'git push' }, { id: 2, at: 2, tool: 'Bash', input: null }]).items, []);
});

test('rows that are not plain objects are skipped, the rest still classify', () => {
  const good = row('git push origin main', PUSH_OUT, 'ok');
  assert.deepEqual(classifyChanges([null]).items, []);
  assert.deepEqual(classifyChanges([undefined, 5, 'x', [], null]).items, []);
  assert.equal(classifyChanges([null, good, undefined, 7]).items.length, 1);
  assert.deepEqual(classifyChanges('nope').items, []);
});

test('items carry id, at, agentId, kind, category, title, chips, detail, tag, tagLabel', () => {
  const [it] = classifyChanges([row('git push origin main', PUSH_OUT, 'ok', { agentId: 'agent-7' })]).items;
  for (const k of ['id', 'at', 'agentId', 'kind', 'category', 'title', 'chips', 'detail', 'tag', 'tagLabel']) assert.ok(k in it, k);
  assert.equal(it.agentId, 'agent-7');
  assert.ok(Array.isArray(it.chips));
});

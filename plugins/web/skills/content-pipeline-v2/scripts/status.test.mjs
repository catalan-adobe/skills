import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMMAND_TABLE, cli, renderHelp } from './status.mjs';

test('every command has a one-line help and its flags; the help stays short and narrow', () => {
  for (const c of COMMAND_TABLE) {
    assert.match(c.help, /^[^\n]{10,}$/, `${c.name} needs a one-line help`);
    assert.ok(Array.isArray(c.flags), `${c.name} needs a flags list`);
    for (const f of c.usage.match(/--[a-z-]+/g) ?? []) {
      assert.ok(c.flags.includes(f), `${c.name}: ${f} in usage but not accepted`);
    }
  }
  const help = renderHelp(COMMAND_TABLE);
  const lines = help.split('\n');
  assert.ok(lines.length <= 40, `help is ${lines.length} lines`);
  assert.ok(lines.every((l) => l.length <= 100), 'a help line is wider than 100');
});

test('--help and help print the table without touching a project', async () => {
  const fake = { projectFile: '/nonexistent/project.json' };
  assert.equal(await cli(['--help'], fake), renderHelp(COMMAND_TABLE));
  assert.equal(await cli(['help'], fake), renderHelp(COMMAND_TABLE));
  assert.equal(await cli(['pick', '--help'], fake), renderHelp(COMMAND_TABLE));
  await assert.rejects(cli(['nope'], fake), /Unknown command "nope"\nstatus\.mjs status/);
});

test('cache --help lists the verbs; unknown verbs and flags are refused by name', async () => {
  const fake = { projectFile: '/nonexistent/project.json' };
  const help = await cli(['cache', '--help'], fake);
  assert.match(help, /^status\.mjs cache serve\n/);
  for (const verb of ['stop', 'status', 'url', 'ls', 'has', 'get']) {
    assert.match(help, new RegExp(`\\nstatus\\.mjs cache ${verb}`));
  }
  assert.equal(await cli(['cache'], fake), help);
  await assert.rejects(cli(['cache', 'nope'], fake), /Unknown cache verb "nope"/);
  await assert.rejects(cli(['cache', 'ls', '--bogus'], fake), /--bogus for "cache ls"/);
  await assert.rejects(cli(['cache', 'url'], fake), /needs at least one URL/);
});

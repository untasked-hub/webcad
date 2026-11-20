// Contextual command-hint regression tests. Run with: node test/cmd-hint.test.js
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');

const start = source.indexOf('const CMD_HINTS = {');
const end = source.indexOf('let cmdLogLines = [];', start);
if (start < 0 || end < 0) throw new Error('command hint helpers not found');
const block = source.slice(start, end);

const ctx = {
  state: { tool: 'select' },
  CMD_NAMES: {
    line: 'LINE', l: 'LINE', circle: 'CIRCLE', c: 'CIRCLE',
    rect: 'RECTANGLE', rectangle: 'RECTANGLE', r: 'RECTANGLE',
    move: 'MOVE', copy: 'COPY', offset: 'OFFSET', join: 'JOIN',
    align: 'ALIGN', distribute: 'DISTRIBUTE', samelayer: 'SAME_LAYER',
    units: 'UNITS',
  },
  document: { getElementById: () => null },
};
vm.createContext(ctx);
vm.runInContext(block + '\nthis.cmdHintFor = cmdHintFor;', ctx);

const assert = require('node:assert');
const hint = ctx.cmdHintFor;

// Typed command names resolve to syntax plus a worked example.
const line = hint('line');
assert.ok(line && /LINE dx dy/.test(line.syntax), 'LINE syntax');
assert.strictEqual(line.example, 'line 100 50');

// Aliases resolve to the same hint as the canonical name.
assert.deepStrictEqual(hint('l'), hint('line'));
assert.deepStrictEqual(hint('rect'), hint('rectangle'));

// Partial typing still resolves through the alias table.
assert.ok(/RECTANGLE/.test(hint('rec').syntax));

// Coordinate entry gets the coordinate hint, not a command hint.
assert.ok(/absolute/.test(hint('@100,0').syntax));
assert.ok(/absolute/.test(hint('12,4').syntax));

// Unknown words produce no hint (so the bar stays quiet).
assert.strictEqual(hint('zzz'), null);

// Empty input falls back to the active tool hint.
ctx.state.tool = 'circle';
assert.ok(/CIRCLE r/.test(hint('').syntax));
ctx.state.tool = 'select';
assert.ok(/select/.test(hint('').syntax));

// Every command in the dispatcher has a hint, so nothing is undiscoverable.
for (const name of new Set(Object.values(ctx.CMD_NAMES))) {
  assert.ok(hint(name.toLowerCase()), 'missing hint for ' + name);
}

console.log('PASS contextual command hint syntax, aliases, coordinates, and tool fallback');

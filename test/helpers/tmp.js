'use strict';
// Temporary folders for tests, deleted when the test file finishes (tests download a lot of test data).
const fs = require('fs');
const os = require('os');
const path = require('path');

const made = [];
const cleanup = () => { while (made.length) { const d = made.pop(); try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* in use */ } } };
// After the last test in the file (the runner may end the process without an 'exit' event), and on exit.
require('node:test').after(cleanup);
process.on('exit', cleanup);

function tmpdir(prefix = 'slimtest-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}

module.exports = { tmpdir };

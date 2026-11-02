// Preload for test_time_travel.js: the clock is moved to FAKE_NOW (an ISO
// time) and runs on from there. Without FAKE_NOW it changes nothing.
//
//   FAKE_NOW=2026-11-03T06:58:00Z node -r ./scripts/fakenow.js scripts/test_daily_email.js
//
// The move is kept in FAKE_OFFSET_MS, so every node process the run starts
// (through NODE_OPTIONS) is on the same clock as the first, however much
// later it starts.
'use strict';
let offset = NaN;
if (process.env.FAKE_OFFSET_MS) {
  offset = Number(process.env.FAKE_OFFSET_MS);
} else {
  const start = Date.parse(process.env.FAKE_NOW || '');
  if (Number.isFinite(start)) {
    offset = start - Date.now();
    process.env.FAKE_OFFSET_MS = String(offset);
  }
}
if (Number.isFinite(offset)) {
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + offset); }
    static now() { return RealDate.now() + offset; }
  }
  global.Date = FakeDate;
  // The page's code runs in vm contexts, each with a Date of its own - on the
  // real clock, unless the test hands it one. Those that are not handed one
  // get the moved clock too.
  const vm = require('vm');
  const withDate = (sandbox) => {
    const s = sandbox && typeof sandbox === 'object' ? sandbox : {};
    if (!Object.prototype.hasOwnProperty.call(s, 'Date') && !vm.isContext(s)) s.Date = FakeDate;
    return s;
  };
  const createContext = vm.createContext;
  vm.createContext = function (sandbox, ...rest) { return createContext.call(this, withDate(sandbox), ...rest); };
  const runInNewContext = vm.runInNewContext;
  vm.runInNewContext = function (code, sandbox, ...rest) { return runInNewContext.call(this, code, withDate(sandbox), ...rest); };
}

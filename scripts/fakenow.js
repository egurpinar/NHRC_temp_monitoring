// Preload for test_time_travel.sh: the clock starts at FAKE_NOW (an ISO time)
// and runs on from there. Without FAKE_NOW it changes nothing.
//
//   FAKE_NOW=2026-11-03T06:58:00Z node -r ./scripts/fakenow.js scripts/test_daily_email.js
'use strict';
const start = Date.parse(process.env.FAKE_NOW || '');
if (Number.isFinite(start)) {
  const RealDate = Date;
  const offset = start - RealDate.now();
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + offset); }
    static now() { return RealDate.now() + offset; }
  }
  global.Date = FakeDate;
}

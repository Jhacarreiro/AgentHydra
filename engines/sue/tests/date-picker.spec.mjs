/**
 * date-picker.spec - the common human ways to write a date and time that a phone's native picker is
 * answered with (lib/date-picker.mjs). Browser-free; the page-level hand is in hands.spec.mjs.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePickerInput, pickerWords } from "../lib/date-picker.mjs";

const NOW = new Date(2026, 9, 4, 12, 0); // Sun Oct 4 2026

test("a datetime-local reads US dates with or without separators, month names, and 12h or 24h times", () => {
  const same = "2026-10-06T19:00";
  for (const said of [
    "Oct 6 2026 7pm",
    "10/06/2026 19:00",
    "10062026 0700PM",
    "October 6th, 2026 at 7:00 p.m.",
    "Tue 6 Oct 2026 7 PM",
    "2026-10-06T19:00",
    "10-6-26 7pm",
  ])
    assert.equal(parsePickerInput(said, "datetime-local", "", NOW)?.value, same, said);
  assert.equal(parsePickerInput("Oct 6 7:30am", "datetime-local", "", NOW)?.value, "2026-10-06T07:30", "no year: this year");
  assert.equal(parsePickerInput("Sep 6 7pm", "datetime-local", "", NOW)?.value, "2027-09-06T19:00", "a day already gone is next year's");
  assert.equal(
    parsePickerInput("12am", "datetime-local", "2026-10-06T19:00", NOW)?.value,
    "2026-10-06T00:00",
    "a time alone keeps the date",
  );
});

test("a date alone gets 19:00 only when the box was empty, and says so; a kept time is not changed", () => {
  assert.deepEqual(parsePickerInput("Oct 6 2026", "datetime-local", "", NOW), { value: "2026-10-06T19:00", defaultedTime: true });
  assert.deepEqual(parsePickerInput("Oct 7 2026", "datetime-local", "2026-10-06T08:15", NOW), {
    value: "2026-10-07T08:15",
    defaultedTime: false,
  });
});

test("date, time and month boxes take their own shapes; nonsense and impossible dates are not understood", () => {
  assert.equal(parsePickerInput("10/06/2026", "date", "", NOW)?.value, "2026-10-06");
  assert.equal(parsePickerInput("7:05 pm", "time", "", NOW)?.value, "19:05");
  assert.equal(parsePickerInput("Oct 2026", "month", "", NOW)?.value, "2026-10");
  for (const [said, kind] of [
    ["sometime soon", "datetime-local"],
    ["02/30/2026", "date"],
    ["25:00", "time"],
    ["13/01/2026", "date"],
    ["7pm", "date"],
    ["", "date"],
  ])
    assert.equal(parsePickerInput(said, kind, "", NOW), null, `${said} (${kind})`);
  assert.equal(pickerWords("datetime-local", "2026-10-06T19:00"), "Tue Oct 6 2026, 7:00 PM");
});

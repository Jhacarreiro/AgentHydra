// The Routine manager page (RoutineManagerPage.vue): whether it runs, when it last looked, the central store and the
// proposals waiting for a yes. Read-only; the routines themselves are the Routines folders.
export const routineManager = {
  title: 'Routine manager',
  caption: 'The standing manager that runs the routines on this PC and reads the shared store. Desk runs it; this page only shows it.',
  on: 'On',
  off: 'Off',
  problem: 'Problem',
  notRead: 'Not read yet',
  lastLook: 'Last look',
  nextLook: 'Next look',
  dueNow: 'Due now',
  noLook: 'Not looked yet',
  looksEvery: 'Looks every {when}',
  readError: 'Could not read it: {reason}',
  store: {
    title: 'Central store',
    none: 'No central store is set up.',
    repo: 'Repo',
    runner: 'Runner',
    read: 'Read {when}',
    error: 'Store error: {reason}',
    runsError: 'Run history error: {reason}',
    problems: 'Routines the store could not read',
    problem: '{id}: {reason}',
  },
  proposals: {
    title: 'Waiting for your yes',
    none: 'No proposal is waiting.',
    open: 'Open {name}',
    waiting: 'Waiting for your yes',
  },
  routines: {
    counts: '{total} routines · {running} running · {paused} paused',
  },
}

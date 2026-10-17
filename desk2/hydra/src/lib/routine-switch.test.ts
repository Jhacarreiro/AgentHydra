// The overview's switch on a routine card: on is not paused, and a flip pauses an on routine or resumes an off one.
import { expect, it } from 'bun:test'
import { isRoutinePaused, routineSwitchRequest } from './routine-switch'

it('a routine the owner paused, or whose state reads paused, is off', () => {
  expect(isRoutinePaused({ paused: true, state: 'idle' })).toBe(true)
  expect(isRoutinePaused({ paused: false, state: 'paused' })).toBe(true)
  expect(isRoutinePaused({ paused: false, state: 'idle' })).toBe(false)
})

it('flipping an on routine pauses it, and flipping an off one resumes it', () => {
  expect(routineSwitchRequest({ id: 'example-digest', paused: false, state: 'due' })).toEqual({ pause: 'example-digest' })
  expect(routineSwitchRequest({ id: 'example-digest', paused: true, state: 'paused' })).toEqual({ resume: 'example-digest' })
})

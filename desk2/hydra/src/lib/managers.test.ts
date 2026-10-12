import { describe, expect, test } from 'bun:test'
import { agentDot, canRunAgent, jobOfAgent, managerDot, workerOfAgent } from './managers'

describe('a standing agent\'s work', () => {
  test('a CliMayte worker belongs to the agent when its group begins with the id and a dash', () => {
    expect(workerOfAgent('example-agent-nightly', 'example-agent')).toBe(true)
    // A group that only shares the id's letters is someone else's work.
    expect(workerOfAgent('example-agentx', 'example-agent')).toBe(false)
    expect(workerOfAgent('other-example-agent-x', 'example-agent')).toBe(false)
  })

  test('an HSwarm job belongs to the agent when its label begins with the id', () => {
    expect(jobOfAgent('example-agent-swarm', 'example-agent')).toBe(true)
    expect(jobOfAgent('swarm-example-agent', 'example-agent')).toBe(false)
    expect(jobOfAgent(null, 'example-agent')).toBe(false)
    expect(jobOfAgent(undefined, 'example-agent')).toBe(false)
  })
})

describe('the dots', () => {
  test('an agent state maps to its dot', () => {
    expect(agentDot('running')).toBe('run')
    expect(agentDot('due')).toBe('warn')
    expect(agentDot('idle')).toBe('ok')
    expect(agentDot('off')).toBe('off')
    expect(agentDot('broken')).toBe('bad')
  })

  test('a manager reads red when its read failed, even before it said whether it is on', () => {
    expect(managerDot(true, true)).toBe('bad')
    expect(managerDot(undefined, false)).toBeUndefined()
    expect(managerDot(false, false)).toBe('off')
    expect(managerDot(true, false)).toBe('ok')
  })
})

describe('Run now', () => {
  test('only an idle or due agent that is not already being run can be ticked', () => {
    expect(canRunAgent('idle', false)).toBe(true)
    expect(canRunAgent('due', false)).toBe(true)
    expect(canRunAgent('running', false)).toBe(false)
    expect(canRunAgent('off', false)).toBe(false)
    expect(canRunAgent('broken', false)).toBe(false)
    expect(canRunAgent('idle', true)).toBe(false)
  })
})

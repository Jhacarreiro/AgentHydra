// What a routine run does to AgentHydra's incidents (server/src/incidents.ts): a run that ends failed
// or timed out opens its routine's incident, and the next ok run resolves it. busy and interrupted are
// not failures, so they touch nothing. Pure: the plugin decides when to call and sends the result.

export interface RoutineIncidentRoutine {
  id: string
  name: string
}

export interface RoutineIncidentRun {
  outcome: string
  lastLine: string
}

export type RoutineIncidentAction =
  | { kind: 'record'; scope: 'routine'; key: string; message: string }
  | { kind: 'resolve'; scope: 'routine'; key: string }

export function routineIncidentAction(routine: RoutineIncidentRoutine, run: RoutineIncidentRun): RoutineIncidentAction | null {
  if (run.outcome === 'failed' || run.outcome === 'timed-out') {
    const reason = run.lastLine.trim() || run.outcome
    return { kind: 'record', scope: 'routine', key: routine.id, message: `${routine.name}: ${reason}` }
  }
  if (run.outcome === 'ok') return { kind: 'resolve', scope: 'routine', key: routine.id }
  return null
}

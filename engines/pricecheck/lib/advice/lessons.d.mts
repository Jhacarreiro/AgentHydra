export interface Lesson {
  id: string
  at: string
  machine: string
  repo?: string
  page?: string
  files?: string[]
  points?: number
  pointsAfter?: number
  kind: 'undone' | 'misled' | 'wrong' | 'undone-feedback'
  claim?: string
  why?: string
  adviceKind?: string
  version?: string
  adviceAt?: string
}

export function lessonsDir(): string
export function machineName(): string
export function recordLesson(lesson: Partial<Lesson> & { id: string; kind: string }, root?: string): boolean
export function lessonFromOutcome(outcome: any, advice?: any): boolean
export function lessonFromFeedback(feedback: any, advice?: any): boolean
export function readLessons(): Lesson[]
export function sharedView(): { lessons: Lesson[]; tally: Record<string, number>; lines: string[] }

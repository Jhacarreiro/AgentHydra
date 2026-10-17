/** The Urgency Advisor's setting: GET /api/urgency-advisor, POST { enabled?, intervalMinutes? }. See docs/URGENCY-ADVISOR.md. */
import { app } from '../http-app'
import { getAdvisorSettings, setAdvisorSettings, startUrgencyAdvisor } from '../urgency-advisor'

app.get('/api/urgency-advisor', (c) => c.json(getAdvisorSettings()))

app.post('/api/urgency-advisor', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  return c.json(
    setAdvisorSettings({
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      intervalMinutes: typeof body.intervalMinutes === 'number' ? body.intervalMinutes : undefined,
    }),
  )
})

startUrgencyAdvisor()

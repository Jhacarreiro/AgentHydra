<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { Check, FolderOpen, Plus, X } from '@lucide/vue'
import type { PeopleSaveResponse, PeopleState } from '@shared/people'
import { BUTTON, FIELD } from '@/components/panes/settings-styles'
import { loadPeople, savePeopleRequest } from './api'
import { buildRequest, initials, isBlank, type PeopleForm } from './logic'

// "Your people": three short steps on one page. 1 the highest authority, 2 the managers, 3 save. It writes the
// people folders docs/PEOPLE.md defines and runs the catalog build (server/src/people/). In Settings it is a
// section; on first run (PeopleFirstRun.vue) it sits in a dialog and can be skipped.
defineProps<{ skippable?: boolean }>()
const emit = defineEmits<{ done: [PeopleSaveResponse]; skip: [] }>()

const state = ref<PeopleState | null>(null)
const error = ref<string | null>(null)
const saving = ref(false)
const result = ref<PeopleSaveResponse | null>(null)
const showRulings = ref(false)
const form = reactive<PeopleForm>({ authorityName: '', authorityHow: '', authorityRulings: '', picked: [], added: [] })

const request = computed(() => buildRequest(form, state.value?.starters ?? []))
const count = computed(() => (request.value.authority ? 1 : 0) + request.value.managers.length)
const folder = computed(() => (state.value?.folder ?? '~/.agenthydra/people').replace(/\\/g, '/'))

const isPicked = (slug: string) => form.picked.includes(slug)
const toggle = (slug: string) => {
  form.picked = isPicked(slug) ? form.picked.filter((s) => s !== slug) : [...form.picked, slug]
}

async function save() {
  saving.value = true
  error.value = null
  try {
    result.value = await savePeopleRequest(request.value)
    state.value = result.value.state
    emit('done', result.value)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  try {
    state.value = await loadPeople()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
})

const STEP = 'flex size-5 shrink-0 items-center justify-center rounded-full bg-fill-5 text-ui-sm font-medium text-text-2'
const SHOW = 'text-ui font-medium leading-5 text-text'
</script>

<template>
  <div role="group" aria-label="Your people" class="flex flex-col">
    <p v-if="error" class="mb-3 text-ui leading-4.75 text-danger-text" role="alert">{{ error }}</p>
    <p v-if="!state && !error" class="text-ui leading-4.75 text-text-muted">Loading…</p>

    <template v-if="state">
      <p v-if="state.authority || state.managers.length" class="mb-3 text-ui leading-4.75 text-text-muted" data-testid="have">
        Already set up: {{ [state.authority, ...state.managers].filter(Boolean).join(', ') }}. Saving adds to them.
      </p>

      <!-- 1 -->
      <section class="flex gap-3 border-b border-border pb-5" aria-labelledby="ppl-1">
        <span :class="STEP" aria-hidden="true">1</span>
        <div class="flex min-w-0 flex-1 flex-col gap-2.5">
          <h3 id="ppl-1" :class="SHOW">Highest authority</h3>
          <p class="text-ui-sm leading-4 text-text-muted">The person whose rulings win.</p>
          <input v-model="form.authorityName" :class="FIELD" class="w-full" placeholder="Name" aria-label="Highest authority's name" maxlength="80" />
          <textarea
            v-model="form.authorityHow"
            :class="FIELD"
            class="h-18 w-full resize-none py-1.5 leading-4.75"
            placeholder="How they decide, in a few lines"
            aria-label="How they decide"
          />
          <div v-if="showRulings" class="flex flex-col gap-1">
            <textarea v-model="form.authorityRulings" :class="FIELD" class="h-18 w-full resize-none py-1.5 leading-4.75" placeholder="Past rulings, one per line" aria-label="Rulings" />
          </div>
          <button v-else type="button" class="flex w-fit items-center gap-1 text-ui-sm leading-4 text-text-2 hover:text-text" @click="showRulings = true">
            <Plus class="size-3.5" /> Add rulings
          </button>
        </div>
      </section>

      <!-- 2 -->
      <section class="flex gap-3 border-b border-border py-5" aria-labelledby="ppl-2">
        <span :class="STEP" aria-hidden="true">2</span>
        <div class="flex min-w-0 flex-1 flex-col gap-2">
          <h3 id="ppl-2" :class="SHOW">Managers</h3>
          <p class="text-ui-sm leading-4 text-text-muted">Pick a starter, or add your own.</p>
          <ul class="flex flex-col">
            <li v-for="s in state.starters" :key="s.slug">
              <button
                type="button"
                class="flex h-12 w-full items-center gap-3 rounded-(--radius-8) px-2 text-start hover:bg-fill-hover focus-visible:shadow-(--focus-ring) focus-visible:outline-none"
                :aria-pressed="isPicked(s.slug)"
                :data-starter="s.slug"
                @click="toggle(s.slug)"
              >
                <span class="flex size-8 shrink-0 items-center justify-center rounded-full bg-fill-5 text-ui-sm font-medium text-text-2" aria-hidden="true">{{ initials(s.name) }}</span>
                <span class="min-w-0 flex-1 truncate text-ui leading-5 text-text"><span class="font-medium">{{ s.name }}</span> <span class="text-text-muted">· {{ s.title }}</span></span>
                <span
                  class="flex size-5 shrink-0 items-center justify-center rounded-full border border-border-strong text-white transition-colors duration-150"
                  :class="isPicked(s.slug) ? 'border-transparent bg-accent' : ''"
                  aria-hidden="true"
                >
                  <Check v-if="isPicked(s.slug)" class="size-3" />
                </span>
              </button>
            </li>
            <li v-for="(m, i) in form.added" :key="i" class="flex h-12 items-center gap-2 px-2">
              <input v-model="m.name" :class="FIELD" class="min-w-0 flex-1" placeholder="Name" :aria-label="`Manager ${i + 1} name`" maxlength="80" />
              <input v-model="m.title" :class="FIELD" class="min-w-0 flex-1" placeholder="Role" :aria-label="`Manager ${i + 1} role`" maxlength="80" />
              <button type="button" class="flex size-6 shrink-0 items-center justify-center rounded-full text-text-muted hover:bg-fill-hover hover:text-text" aria-label="Remove manager" @click="form.added.splice(i, 1)">
                <X class="size-3.5" />
              </button>
            </li>
          </ul>
          <button type="button" class="flex w-fit items-center gap-1 px-2 text-ui-sm leading-4 text-text-2 hover:text-text" @click="form.added.push({ name: '', title: '' })">
            <Plus class="size-3.5" /> Add a manager
          </button>
        </div>
      </section>

      <!-- 3 -->
      <section class="flex gap-3 pt-5" aria-labelledby="ppl-3">
        <span :class="STEP" aria-hidden="true">3</span>
        <div class="flex min-w-0 flex-1 flex-col gap-2.5">
          <h3 id="ppl-3" :class="SHOW">Done</h3>
          <p class="flex items-center gap-1.5 text-ui-sm leading-4 text-text-muted">
            <FolderOpen class="size-3.5 shrink-0" aria-hidden="true" />
            <span class="min-w-0 break-all">{{ folder }}</span>
          </p>
          <p v-if="result" class="flex items-center gap-1.5 text-ui leading-4.75" :class="result.catalog.ok ? 'text-success-text' : 'text-danger-text'" role="status">
            <Check v-if="result.catalog.ok" class="size-3.5 shrink-0" />
            {{ result.catalog.ok ? `Saved ${result.written.length}. Hydra Core sees them now.` : `Saved ${result.written.length}, but the catalog build failed: ${result.catalog.message}` }}
          </p>
          <div class="flex items-center gap-3">
            <button
              type="button"
              class="flex h-8 items-center rounded-full bg-accent px-4 text-ui font-medium text-white hover:bg-accent-hover focus-visible:shadow-(--focus-ring) focus-visible:outline-none disabled:opacity-50"
              :disabled="saving || isBlank(request)"
              :aria-busy="saving"
              @click="save"
            >
              {{ saving ? 'Saving…' : count ? `Save ${count} ${count === 1 ? 'person' : 'people'}` : 'Save' }}
            </button>
            <button v-if="skippable && !result" type="button" :class="BUTTON" @click="emit('skip')">Skip for now</button>
            <button v-if="skippable && result" type="button" :class="BUTTON" @click="emit('skip')">Close</button>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

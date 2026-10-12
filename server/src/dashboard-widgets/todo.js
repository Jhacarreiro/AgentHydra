;(() => {
  const URL_JSON = '/_hydra/todo.json'
  const EVERY_MS = 30000

  function item(task) {
    const li = document.createElement('li')
    li.textContent = task.title || task.id
    return li
  }

  function render(data) {
    for (const el of document.querySelectorAll('[data-hydra-todo]')) {
      el.textContent = ''
      if (!data?.available) continue
      const list = document.createElement('ul')
      for (const task of data.ready || []) list.appendChild(item(task))
      el.appendChild(list)
    }
  }

  function load() {
    fetch(URL_JSON, { cache: 'no-store' })
      .then((r) => r.json())
      .then(render)
      .catch(() => {
        render(null)
      })
  }

  load()
  setInterval(load, EVERY_MS)
})()

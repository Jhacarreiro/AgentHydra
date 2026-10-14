// Not built yet: the core's server, store and chat loop (core/README.md). Replaced by its builder.
import { accounts } from './accounts'
import { chatgptBackend } from './backends/chatgpt'
import { claudeBackend } from './backends/claude'
import { codexBackend } from './backends/codex'
import { history } from './history'

export const parts = { accounts, history, backends: [claudeBackend, codexBackend, chatgptBackend] }

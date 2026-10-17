export type CliDialogNamespace = 'cliInstances' | 'codexInstances' | 'dshInstances' | 'freeInstances'

// Keep these as full, static key paths. Besides making the reusable dialogs type-safe, this lets
// the locale audit verify both namespaces instead of treating template-built paths as unknown.
export const CLI_INSTANCE_DIALOG_KEYS = {
  cliInstances: {
    nameLabel: 'cliInstances.nameLabel',
    namePlaceholder: 'cliInstances.namePlaceholder',
    renameDialogTitle: 'cliInstances.renameDialogTitle',
    renameDialogDescription: 'cliInstances.renameDialogDescription',
    renameDialogSubmit: 'cliInstances.renameDialogSubmit',
    renameDialogRenaming: 'cliInstances.renameDialogRenaming',
  },
  dshInstances: {
    nameLabel: 'dshInstances.nameLabel',
    namePlaceholder: 'dshInstances.namePlaceholder',
    renameDialogTitle: 'dshInstances.renameDialogTitle',
    renameDialogDescription: 'dshInstances.renameDialogDescription',
    renameDialogSubmit: 'dshInstances.renameDialogSubmit',
    renameDialogRenaming: 'dshInstances.renameDialogRenaming',
  },
  codexInstances: {
    nameLabel: 'codexInstances.nameLabel',
    namePlaceholder: 'codexInstances.namePlaceholder',
    renameDialogTitle: 'codexInstances.renameDialogTitle',
    renameDialogDescription: 'codexInstances.renameDialogDescription',
    renameDialogSubmit: 'codexInstances.renameDialogSubmit',
    renameDialogRenaming: 'codexInstances.renameDialogRenaming',
  },
  freeInstances: {
    nameLabel: 'freeInstances.nameLabel',
    namePlaceholder: 'freeInstances.namePlaceholder',
    renameDialogTitle: 'freeInstances.renameDialogTitle',
    renameDialogDescription: 'freeInstances.renameDialogDescription',
    renameDialogSubmit: 'freeInstances.renameDialogSubmit',
    renameDialogRenaming: 'freeInstances.renameDialogRenaming',
  },
} as const

/** The delete dialog (DeleteInstanceDialog.vue) on all four instance tables. The "why" note field
 *  is one shared wording (instances.deleteDialogNoteLabel / deleteDialogNoteHint), not per table. */
export type DeleteDialogNamespace = 'instances' | CliDialogNamespace

export const DELETE_DIALOG_KEYS = {
  instances: {
    title: 'instances.deleteDialogTitle',
    description: 'instances.deleteDialogDescription',
    submit: 'instances.deleteDialogSubmit',
    deleting: 'instances.deleteDialogDeleting',
  },
  cliInstances: {
    title: 'cliInstances.deleteDialogTitle',
    description: 'cliInstances.deleteDialogDescription',
    submit: 'cliInstances.deleteDialogSubmit',
    deleting: 'cliInstances.deleteDialogDeleting',
  },
  codexInstances: {
    title: 'codexInstances.deleteDialogTitle',
    description: 'codexInstances.deleteDialogDescription',
    submit: 'codexInstances.deleteDialogSubmit',
    deleting: 'codexInstances.deleteDialogDeleting',
  },
  dshInstances: {
    title: 'dshInstances.deleteDialogTitle',
    description: 'dshInstances.deleteDialogDescription',
    submit: 'dshInstances.deleteDialogSubmit',
    deleting: 'dshInstances.deleteDialogDeleting',
  },
  freeInstances: {
    title: 'freeInstances.deleteDialogTitle',
    description: 'freeInstances.deleteDialogDescription',
    submit: 'freeInstances.deleteDialogSubmit',
    deleting: 'freeInstances.deleteDialogDeleting',
  },
} as const satisfies Record<DeleteDialogNamespace, Record<string, string>>

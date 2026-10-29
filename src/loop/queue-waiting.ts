import type { TrackerConnector } from './connectors.js'

/** Tell each issue that `tracker.requireLabel` keeps out of the queue why it waits; one comment per issue and label, not one per tick. Returns the failures as notes. */
export const commentWaiting = async (tracker: Pick<TrackerConnector, 'comment'>, issues: readonly string[], label: string): Promise<string[]> => {
  const notes: string[] = []
  for (const issue of issues) {
    try { await tracker.comment({ issue, body: `**Loop: waiting for the PM**\n\nThe PM has not checked this issue yet. It is contracted once it carries \`${label}\`.`, dedupeKey: `waiting:${issue}:${label}` }) } catch (error) { notes.push(`waiting comment for ${issue} failed: ${error instanceof Error ? error.message : String(error)}`) }
  }
  return notes
}

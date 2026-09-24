/** Provider-neutral issue model used at the tracker seam. */
export interface TrackerIssue {
  readonly id: string
  readonly identifier: string
  readonly title: string
  readonly url: string
  readonly state: string
  readonly stateType: string
  readonly assignee: string | null
  readonly assigneeId: string | null
  readonly labels: readonly string[]
  readonly priority: number
  readonly priorityLabel: string
  readonly project: string | null
  readonly branchName: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface TrackerComment {
  readonly author: string | null
  readonly body: string
  readonly createdAt: string
}

export interface TrackerIssueDetail extends TrackerIssue {
  readonly description: string
  readonly comments: readonly TrackerComment[]
  readonly raw: unknown
}

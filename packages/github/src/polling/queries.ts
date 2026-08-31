export const ISSUE_PAYLOAD_QUERY = `
  query UsineIssuePayload($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        number
        title
        body
        url
        state
        stateReason
        createdAt
        updatedAt
        closedAt
        author { login }
        issueType { name }
        milestone { title }
        labels(first: 50) {
          totalCount
          nodes { name }
        }
        assignees(first: 10) {
          totalCount
          nodes { login }
        }
        comments(last: 20) {
          totalCount
          nodes {
            author { login }
            body
            createdAt
          }
        }
        closedByPullRequestsReferences(first: 10, includeClosedPrs: true) {
          totalCount
          nodes {
            number
            state
            isDraft
            url
          }
        }
      }
    }
  }
`;

export const PULL_REQUEST_PAYLOAD_QUERY = `
  query UsinePullRequestPayload($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        number
        title
        body
        url
        state
        isDraft
        merged
        createdAt
        updatedAt
        mergedAt
        author { login }
        baseRefName
        headRefName
        headRefOid
        additions
        deletions
        changedFiles
        reviewDecision
        statusCheckRollup { state }
        labels(first: 50) {
          totalCount
          nodes { name }
        }
        reviewRequests(first: 10) {
          totalCount
          nodes {
            requestedReviewer {
              ... on User { login }
            }
          }
        }
        reviews(last: 20) {
          totalCount
          nodes {
            author { login }
            state
            body
            submittedAt
            commit { oid }
          }
        }
        reviewThreads(first: 50) {
          totalCount
          nodes {
            isResolved
            isOutdated
            path
            comments(first: 10) {
              totalCount
              nodes {
                author { login }
                body
              }
            }
          }
        }
        comments(last: 20) {
          totalCount
          nodes {
            author { login }
            body
            createdAt
          }
        }
        closingIssuesReferences(first: 10) {
          totalCount
          nodes {
            number
            state
          }
        }
      }
    }
  }
`;

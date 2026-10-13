/**
 * GitLab webhook payloads, taken from the documented examples at
 * docs.gitlab.com/user/project/integrations/webhook_events/ (read 2026-10-13). Field names and
 * values are the documentation's; arrays that repeat the same shape are shortened, and
 * `client_secret`-style fields do not occur. They are NOT captured from a real GitLab instance.
 */
const project = {
  id: 15,
  name: 'Diaspora',
  description: '',
  web_url: 'https://gitlab.com/mike/diaspora',
  avatar_url: null,
  git_ssh_url: 'git@gitlab.com:mike/diaspora.git',
  git_http_url: 'https://gitlab.com/mike/diaspora.git',
  namespace: 'Mike',
  visibility_level: 0,
  path_with_namespace: 'mike/diaspora',
  default_branch: 'master',
  ci_config_path: null,
};

export const PUSH = {
  object_kind: 'push',
  event_name: 'push',
  before: '95790bf891e76fee5e1747ab589903a6a1f80f22',
  after: 'da1560886d4f094c3e6c9ef40349f7d38b5d27d7',
  ref: 'refs/heads/master',
  ref_protected: true,
  checkout_sha: 'da1560886d4f094c3e6c9ef40349f7d38b5d27d7',
  message: 'Hello World',
  user_id: 4,
  user_name: 'John Smith',
  user_username: 'jsmith',
  user_email: 'john@example.com',
  user_avatar: 'https://s.gravatar.com/avatar/d4c74594d841139328695756648b6bd6?s=80',
  project_id: 15,
  project,
  commits: [
    {
      id: 'b6568db1bc1dcd7f8b4d5a946b0b91f9dacd7327',
      message:
        'Update Catalan translation to e38cb41.\n\nSee https://gitlab.com/gitlab-org/gitlab for more information',
      title: 'Update Catalan translation to e38cb41.',
      timestamp: '2011-12-12T14:27:31+02:00',
      url: 'https://gitlab.com/mike/diaspora/commit/b6568db1bc1dcd7f8b4d5a946b0b91f9dacd7327',
      author: { name: 'Jordi Mallach', email: 'jordi@softcatala.org' },
      added: ['CHANGELOG'],
      modified: ['app/controller/application.rb'],
      removed: [],
    },
    {
      id: 'da1560886d4f094c3e6c9ef40349f7d38b5d27d7',
      message: 'fixed readme',
      title: 'fixed readme',
      timestamp: '2012-01-03T23:36:29+02:00',
      url: 'https://gitlab.com/mike/diaspora/commit/da1560886d4f094c3e6c9ef40349f7d38b5d27d7',
      author: { name: 'GitLab dev user', email: 'gitlabdev@dv6700.(none)' },
      added: ['CHANGELOG'],
      modified: ['app/controller/application.rb'],
      removed: [],
    },
  ],
  total_commits_count: 4,
  push_options: {},
  repository: {
    name: 'Diaspora',
    url: 'git@gitlab.com:mike/diaspora.git',
    description: '',
    homepage: 'https://gitlab.com/mike/diaspora',
    git_http_url: 'https://gitlab.com/mike/diaspora.git',
    git_ssh_url: 'git@gitlab.com:mike/diaspora.git',
    visibility_level: 0,
  },
};

export const ISSUE = {
  object_kind: 'issue',
  event_type: 'issue',
  user: {
    id: 1,
    name: 'Administrator',
    username: 'root',
    avatar_url: 'http://www.gravatar.com/avatar/e64c7d89f26bd1972efa854d13d7dd61?s=40&d=identicon',
    email: 'admin@example.com',
  },
  project: { ...project, id: 1, name: 'Gitlab Test', path_with_namespace: 'gitlabhq/gitlab-test' },
  object_attributes: {
    id: 301,
    title: 'New API: create/update/delete file',
    assignee_ids: [51],
    assignee_id: 51,
    author_id: 51,
    project_id: 14,
    created_at: '2013-12-03T17:15:43.000Z',
    updated_at: '2013-12-03T17:15:43.000Z',
    description: 'Create new API for manipulations with repository',
    state_id: 1,
    confidential: false,
    type: 'Issue',
    iid: 23,
    url: 'https://gitlab.com/diaspora/issues/23',
    state: 'opened',
    action: 'open',
  },
  labels: [
    {
      id: 206,
      title: 'API',
      color: '#ffffff',
      project_id: 14,
      template: false,
      description: 'API related issues',
      type: 'ProjectLabel',
      group_id: 41,
    },
  ],
};

export const MERGE_REQUEST = {
  object_kind: 'merge_request',
  event_type: 'merge_request',
  user: {
    id: 1,
    name: 'Alex Garcia',
    username: 'agarcia',
    avatar_url:
      'https://www.gravatar.com/avatar/1a29da0ccd099482194440fac762f5ccb4ec53227761d1859979367644a889a5?s=80&d=identicon',
    email: 'agarcia@example.com',
  },
  project: {
    ...project,
    id: 2,
    name: 'Flight Management',
    web_url: 'https://gitlab.com/flightjs/flight-management',
    path_with_namespace: 'flightjs/flight-management',
    default_branch: 'main',
  },
  object_attributes: {
    author_id: 1,
    created_at: '2026-01-16T05:56:22.000Z',
    description: 'This merge request adds input validation to the booking form.',
    draft: false,
    id: 93,
    iid: 16,
    merge_status: 'checking',
    source_branch: 'feature/booking-validation',
    source_project_id: 2,
    state_id: 1,
    target_branch: 'main',
    target_project_id: 2,
    title: 'Add input validation to booking form',
    updated_at: '2026-01-16T05:56:25.000Z',
    state: 'opened',
    url: 'https://gitlab.com/flightjs/flight-management/-/merge_requests/16',
    action: 'open',
    actioned_at: '2026-01-16T05:56:26.000Z',
  },
  changes: {
    merge_status: { previous: 'preparing', current: 'checking' },
  },
  assignees: [{ id: 1, name: 'Alex Garcia', username: 'agarcia', email: '[REDACTED]' }],
};

export const PIPELINE = {
  object_kind: 'pipeline',
  object_attributes: {
    id: 31,
    iid: 3,
    name: 'Pipeline for branch: master',
    ref: 'master',
    tag: false,
    sha: 'bcbb5ec396a2c0f828686f14fac9b80b780504f2',
    before_sha: 'bcbb5ec396a2c0f828686f14fac9b80b780504f2',
    source: 'merge_request_event',
    status: 'success',
    detailed_status: 'passed',
    stages: ['build', 'test', 'deploy'],
    created_at: '2016-08-12T15:23:28.000Z',
    finished_at: '2016-08-12T15:26:29.000Z',
    duration: 63,
    queued_duration: 10,
    variables: [{ key: 'NESTOR_PROD_ENVIRONMENT', value: 'us-west-1' }],
    url: 'https://gitlab.com/gitlab-org/gitlab-test/-/pipelines/31',
  },
  user: {
    id: 1,
    name: 'Administrator',
    username: 'root',
    email: 'user_email@gitlab.com',
  },
  project: { ...project, id: 1, name: 'Gitlab Test', path_with_namespace: 'gitlab-org/gitlab-test' },
  commit: {
    id: 'bcbb5ec396a2c0f828686f14fac9b80b780504f2',
    message: 'test\n',
    title: 'test',
    timestamp: '2016-08-12T17:23:21+02:00',
    url: 'https://gitlab.com/gitlab-org/gitlab-test/commit/bcbb5ec396a2c0f828686f14fac9b80b780504f2',
    author: { name: 'User', email: 'user@gitlab.com' },
  },
  builds: [
    { id: 380, stage: 'deploy', name: 'production', status: 'skipped', when: 'manual', manual: true },
    { id: 377, stage: 'test', name: 'test-build', status: 'success' },
  ],
};

/** The documented pipeline example with `status` changed to `failed` and one failed job. */
export const PIPELINE_FAILED = {
  ...PIPELINE,
  object_attributes: { ...PIPELINE.object_attributes, status: 'failed', detailed_status: 'failed' },
  builds: [...PIPELINE.builds, { id: 378, stage: 'test', name: 'test-image', status: 'failed' }],
};

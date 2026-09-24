import { connectHost } from '@openchamber/sdk';

type Commit = { hash: string; subject: string; author: string; date: string };
type HistoryResponse = { repository: string; commits: Commit[] };
type ErrorResponse = { error?: string; code?: string };
type Host = ReturnType<typeof connectHost>;

const host: Host = connectHost();
const content = document.querySelector('#content') as HTMLElement;
const loading = document.querySelector('#loading-state') as HTMLElement;
const message = document.querySelector('#message-state') as HTMLElement;
const messageIcon = document.querySelector('#message-icon') as HTMLElement;
const messageTitle = document.querySelector('#message-title') as HTMLElement;
const messageCopy = document.querySelector('#message-copy') as HTMLElement;
const messageAction = document.querySelector('#message-action') as HTMLButtonElement;
const history = document.querySelector('#history-state') as HTMLElement;
const list = document.querySelector('#commit-list') as HTMLOListElement;
const refresh = document.querySelector('#refresh-button') as HTMLButtonElement;
const repositoryName = document.querySelector('#repository-name') as HTMLElement;
const directoryLabel = document.querySelector('#directory-label') as HTMLElement;
const count = document.querySelector('#commit-count') as HTMLElement;

let directory = '';
let requestVersion = 0;
let lastErrorCanRetry = false;

function applyTheme(tokens?: {
  background: string; elevated: string; foreground: string; muted: string; border: string;
  primary: string; mutedSurface: string; mono: string; radius: string;
}) {
  if (!tokens) return;
  const mapped: Record<string, string> = {
    '--bg': tokens.background, '--panel': tokens.elevated, '--text': tokens.foreground,
    '--muted': tokens.muted, '--line': tokens.border, '--accent': tokens.primary,
    '--accent-dim': tokens.primary, '--mono': tokens.mono,
  };
  for (const [key, value] of Object.entries(mapped)) document.documentElement.style.setProperty(key, value);
}

function setState(state: 'loading' | 'message' | 'history') {
  loading.hidden = state !== 'loading';
  message.hidden = state !== 'message';
  history.hidden = state !== 'history';
  content.setAttribute('aria-busy', String(state === 'loading'));
}

function showMessage(title: string, copy: string, icon: string, retry = false) {
  lastErrorCanRetry = retry;
  messageIcon.textContent = icon;
  messageTitle.textContent = title;
  messageCopy.textContent = copy;
  messageAction.hidden = !retry;
  messageAction.textContent = 'Try again';
  setState('message');
}

function errorDetails(status: number, body: ErrorResponse) {
  const code = body?.code?.toLowerCase() ?? '';
  if (!directory) return ['No project selected', 'Open a project to see its recent commits.', '⌁', false] as const;
  if (code === 'not_repository' || code === 'not-repository' || code === 'not_git' || code === 'not-git' || status === 422 || status === 404) return ['Not a Git repository', 'This project is not a Git repository.', '◇', false] as const;
  if (status === 403 || code.includes('permission')) return ['Access denied', 'The history service cannot read this project directory.', '!', true] as const;
  return ['Could not load history', body?.error || 'Something went wrong while reading this project.', '!', true] as const;
}

function formatDate(input: string) {
  const date = new Date(input);
  if (Number.isNaN(date.valueOf())) return input;
  const now = Date.now();
  const days = Math.floor((now - date.valueOf()) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30 && days > 1) return `${days}d ago`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

function render(data: HistoryResponse) {
  repositoryName.textContent = data.repository || 'Unnamed repository';
  const commits = Array.isArray(data.commits) ? data.commits : [];
  if (!commits.length) {
    showMessage('No commits yet', 'Once this repository has a commit, it will appear here.', '·', false);
    return;
  }
  count.textContent = `${commits.length} commit${commits.length === 1 ? '' : 's'}`;
  list.replaceChildren();
  for (const commit of commits) {
    const item = document.createElement('li');
    item.className = 'commit';
    const top = document.createElement('div'); top.className = 'commit-top';
    const subject = document.createElement('span'); subject.className = 'commit-subject'; subject.textContent = commit.subject || '(no subject)';
    const date = document.createElement('time'); date.className = 'commit-date'; date.textContent = formatDate(commit.date); date.dateTime = commit.date;
    top.append(subject, date);
    const bottom = document.createElement('div'); bottom.className = 'commit-bottom';
    const hash = document.createElement('span'); hash.className = 'commit-hash'; hash.textContent = (commit.hash || '').slice(0, 7);
    const author = document.createElement('span'); author.className = 'commit-author'; author.textContent = commit.author || 'Unknown author';
    bottom.append(hash, author); item.append(top, bottom); list.append(item);
  }
  setState('history');
}

function clearProject() {
  repositoryName.textContent = 'Waiting for a project…';
  directoryLabel.textContent = 'No project selected';
  count.textContent = '';
  list.replaceChildren();
}

function parseBody(body: string): HistoryResponse | ErrorResponse {
  try { return JSON.parse(body) as HistoryResponse | ErrorResponse; }
  catch { throw Object.assign(new Error('Malformed service response'), { status: 502, body: {} }); }
}

async function load(nextDirectory: string | null = directory) {
  const version = ++requestVersion;
  directory = nextDirectory || '';
  clearProject();
  if (!directory) {
    refresh.disabled = false;
    showMessage('No project selected', 'Open a project to see its recent commits.', '⌁', false);
    return;
  }
  directoryLabel.textContent = directory;
  refresh.disabled = true;
  setState('loading');
  try {
    const response = await host.serviceRequest({ method: 'GET', path: '/history', query: { directory, limit: '50' } });
    if (version !== requestVersion || directory !== nextDirectory) return;
    const body = parseBody(response.body);
    if (response.status < 200 || response.status >= 300) {
      const details = errorDetails(response.status, body as ErrorResponse);
      showMessage(...details);
      return;
    }
    render(body as HistoryResponse);
  } catch (error) {
    if (version !== requestVersion) return;
    const e = error as { status?: number; body?: ErrorResponse };
    showMessage(...errorDetails(e.status || 500, e.body || {}));
  } finally {
    if (version === requestVersion) refresh.disabled = false;
  }
}

refresh.addEventListener('click', () => load());
messageAction.addEventListener('click', () => { if (lastErrorCanRetry) load(); });
host.onReady((context) => {
  applyTheme(context.theme.tokens);
  load(context.directory);
});
host.onDirectory((nextDirectory) => load(nextDirectory));

import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_LIMIT = 50;
const MAX_DIRECTORY_LENGTH = 4096;
const MAX_GIT_OUTPUT = 128 * 1024;
const MAX_RESPONSE_LENGTH = 240 * 1024;
const GIT_TIMEOUT_MS = 5000;

function json(response, status, body) {
  const serialized = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(serialized),
    'cache-control': 'no-store',
  });
  response.end(serialized);
}

function error(response, status, code, message) {
  json(response, status, { error: message, code });
}

function gitEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_/i.test(key)) delete env[key];
  }
  env.GIT_NO_LAZY_FETCH = '1';
  return env;
}

async function runGit(args, directory) {
  try {
    return await execFileAsync('git', args, {
      cwd: directory,
      env: gitEnvironment(),
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_GIT_OUTPUT,
      windowsHide: true,
    });
  } catch (cause) {
    if (cause.code === 'ENOENT') {
      const unavailable = new Error('Git executable is unavailable');
      unavailable.code = 'GIT_UNAVAILABLE';
      throw unavailable;
    }
    throw cause;
  }
}

function parseCommits(output) {
  // Git adds one LF after each --format record. The NUL separators are the
  // framing because commit fields cannot contain NUL; RS is valid field data.
  if (!output.endsWith('\0\n')) throw new Error('Malformed Git log record terminator');
  output = output.slice(0, -1);
  const fields = output.split('\0');
  if (fields.at(-1) !== '') throw new Error('Malformed Git log record terminator');
  fields.pop();
  if (fields.length % 4 !== 0) throw new Error('Malformed Git log record framing');

  const commits = [];
  for (let index = 0; index < fields.length; index += 4) {
    const hash = index === 0 ? fields[index] : fields[index].replace(/^\n/, '');
    const author = fields[index + 1];
    const date = fields[index + 2];
    const subject = fields[index + 3];
    if (!/^[0-9a-f]{40,64}$/i.test(hash) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(date)
      || !Number.isFinite(Date.parse(date))) {
      throw new Error('Malformed Git log commit fields');
    }
    commits.push({ hash, subject, author, date });
  }
  return commits;
}

async function handleHistory(url, response) {
  const directory = url.searchParams.get('directory');
  if (!directory || directory.length > MAX_DIRECTORY_LENGTH || !directory.startsWith('/')) {
    error(response, 400, 'MALFORMED_PATH', 'directory must be an absolute path of at most 4096 characters');
    return;
  }

  let realDirectory;
  try {
    const fs = await import('node:fs/promises');
    realDirectory = await fs.realpath(directory);
    const stat = await fs.stat(realDirectory);
    if (!stat.isDirectory()) throw Object.assign(new Error('Path is not a directory'), { code: 'ENOTDIR' });
  } catch {
    error(response, 400, 'MALFORMED_PATH', 'directory does not resolve to an existing directory');
    return;
  }

  let repository;
  try {
    const result = await runGit(['rev-parse', '--show-toplevel'], realDirectory);
    repository = result.stdout.trim();
    if (!repository || !repository.startsWith('/')) throw new Error('Git returned an invalid repository path');
    const fs = await import('node:fs/promises');
    repository = await fs.realpath(repository);
  } catch (cause) {
    if (cause.code === 'GIT_UNAVAILABLE') {
      error(response, 503, 'UNAVAILABLE', cause.message);
    } else if (cause.code === 'ETIMEDOUT' || cause.killed && cause.signal === 'SIGTERM') {
      error(response, 500, 'GIT_FAILED', 'Git command timed out');
    } else if (cause.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      error(response, 500, 'GIT_FAILED', 'Git command output exceeded the allowed size');
    } else {
      error(response, 404, 'NOT_REPOSITORY', 'The directory is not inside a Git repository');
    }
    return;
  }

  const requested = Number(url.searchParams.get('limit') ?? MAX_LIMIT);
  const limit = Number.isInteger(requested) ? Math.max(0, Math.min(requested, MAX_LIMIT)) : MAX_LIMIT;
  try {
    await runGit(['rev-parse', '--verify', 'HEAD'], repository);
  } catch (cause) {
    if (cause.code === 'GIT_UNAVAILABLE') {
      error(response, 503, 'UNAVAILABLE', cause.message);
      return;
    }
    try {
      // A symbolic HEAD with no commits reachable from any ref is an unborn
      // branch. Verify rev-list succeeds as well, so corrupt refs are errors.
      const symbolicHead = await runGit(['symbolic-ref', '-q', 'HEAD'], repository);
      if (symbolicHead.stdout.trim()) {
        const refs = await runGit(['rev-list', '--all', '--max-count=1'], repository);
        if (!refs.stdout.trim()) {
          json(response, 200, { repository, commits: [] });
          return;
        }
      }
      error(response, 500, 'GIT_FAILED', 'Git could not verify repository HEAD');
    } catch {
      error(response, 500, 'GIT_FAILED', 'Git could not verify repository HEAD');
    }
    return;
  }

  if (limit === 0) {
    json(response, 200, { repository, commits: [] });
    return;
  }

  let commits;
  try {
    const result = await runGit([
      '--no-pager',
      '-C', repository,
      'log',
      `--max-count=${limit}`,
      '--date=iso-strict',
      '--no-color',
      '--no-show-signature',
      '--format=%H%x00%an%x00%aI%x00%s%x00',
    ], repository);
    commits = parseCommits(result.stdout).slice(0, limit);
  } catch (cause) {
    if (cause.code === 'GIT_UNAVAILABLE') {
      error(response, 503, 'UNAVAILABLE', cause.message);
    } else {
      error(response, 500, 'GIT_FAILED', 'Git could not read commit history');
    }
    return;
  }

  const body = { repository, commits };
  if (JSON.stringify(body).length > MAX_RESPONSE_LENGTH) {
    error(response, 500, 'GIT_FAILED', 'Git history response exceeded the allowed size');
    return;
  }
  json(response, 200, body);
}

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN;
if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) {
  throw new Error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
}

const server = createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) {
    error(response, 401, 'UNAUTHORIZED', 'A valid bearer token is required');
    return;
  }

  let url;
  try {
    url = new URL(request.url, 'http://127.0.0.1');
  } catch {
    error(response, 400, 'MALFORMED_PATH', 'Request URL is malformed');
    return;
  }

  if (request.method !== 'GET' || url.pathname !== '/history') {
    error(response, 404, 'NOT_FOUND', 'Only GET /history is available');
    return;
  }

  handleHistory(url, response).catch(() => {
    if (!response.headersSent) error(response, 500, 'GIT_FAILED', 'Unable to read Git history');
    else response.destroy();
  });
});

server.listen(port, '127.0.0.1');

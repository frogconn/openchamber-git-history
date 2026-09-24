# Git History

Git History is an OpenChamber panel extension that displays up to the 50 most
recent commits for the currently open project. The panel owns manual refresh
and project-directory switching; this service exposes the local Git history
endpoint consumed by the panel.

## Build and install

From this extension's absolute folder:

```sh
cd /absolute/path/to/openchamber-extensions/git-history
npm install
npm run build
```

Install the extension in OpenChamber using that absolute folder path. Approve
the requested host service and `git` executable permission when prompted. The
service is native Node.js and is not bundled; the build bundles the panel entry
`panel/main.ts` into `panel/main.js`.

## Service contract

The service binds only to `127.0.0.1` and reads `OPENCHAMBER_SERVICE_PORT` and
`OPENCHAMBER_SERVICE_TOKEN` from its host-provided environment. Every route
requires `Authorization: Bearer <token>`. The fixed endpoint is:

```http
GET /history?directory=<absolute-project-directory>&limit=50
```

A successful response is JSON in the form
`{ "repository": "<canonical Git root>", "commits": [...] }`, where each
commit has a full hash, first-line subject, author name, and strict ISO date.
The requested limit is capped at 50 (and defaults to 50); an unborn repository
returns an empty `commits` array. Errors are JSON objects with human-readable
`error` and stable `code` fields: malformed paths return 400, directories
outside a Git repository return 404, Git failures return 500, and a missing
Git executable returns 503.

The supplied project directory is treated as trusted-local-service input. This
is not an authorization boundary: the local bearer token protects the service
route, but directory selection itself is not a guarantee that callers can
access only one project. The service uses Git's fixed argument list without a
shell, strips Git environment overrides, applies command timeouts and output
bounds, and never fetches from a remote. History reflects the current local
repository state; remote-only commits are not fetched automatically.

## Limitations

- History refresh is explicit in the panel; there is no background polling.
- Only the latest 50 local commits are available.
- Git must be installed and available to the OpenChamber host service.
- Repository state is local and may not include commits on remote branches.

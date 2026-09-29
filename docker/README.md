# Cloud Shell container

Image includes:

- Node.js 24 + repository dependencies
- Google Chrome + Xvfb for CDP browser accounts
- tmux for durable execution lanes
- OpenClaw 2026.9.5
- ChatGPT adapter + workflow runtime

Build:

```bash
./docker/build.sh
```

Run:

```bash
./docker/run-cloud-shell.sh
```

For a lighter Cloud Shell instance:

```bash
ACCOUNT_COUNT=1 ./docker/run-cloud-shell.sh
```

Persistent Docker volumes hold workflow SQLite data, four Chrome profiles, and OpenClaw state. The first run needs ChatGPT login inside each Chrome profile. The adapter HTTP API is exposed on port `8318`.

To use a different image/container:

```bash
IMAGE=my-image:tag CONTAINER=my-adapter ./docker/run-cloud-shell.sh
```


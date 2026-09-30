# Legacy reference

The earlier TypeScript bot service remains in src/ and test/ for reference and
regression coverage. It is not the active assistant and is not portable company
onboarding. Its original sender rules are intentionally restrictive. Do not use
its .env.example/config.example.json to configure the OpenClaw integration.

Only explicit `legacy:*` package commands start or inspect that service. Never run
it against a Telegram bot already polled by OpenClaw. Use README.md and
agent-onboarding.md for a new installation.

# AnthropicEIRA

Scheduled Node job that reads open Oracle `EVENT` rows, asks Claude for an incident priority, and writes the answer into `EVENT_AI`.

Meant to run on a timer (about every 10 minutes). Each pass handles a small batch of events that do not already have an `EVENT_AI` row.

## What it does

- Selects up to 5 pending events from Oracle (`state_id` / agenda / category filters in `index.js`)
- Sends subject + description to Claude Haiku and expects JSON like `{"priorita":"1"}` (1 high, 2 medium, 3 low)
- Inserts `EVENT_ID`, truncated response, and priority into `EVENT_AI`
- Writes daily `output` / `table` logs under `logs/`, tagged `_success` or `_error`
- Zips logs older than 30 days, deletes anything older than 90 days

## Stack

- Node.js, Yarn
- `oracledb` (thick mode / Instant Client)
- `@anthropic-ai/sdk`
- `dotenv`, `console.table`

## Setup

Needs Node.js LTS, Yarn, and [Oracle Instant Client](https://www.oracle.com/database/technologies/instant-client/downloads.html).

```bash
git clone https://github.com/AkiraGold/AnthropicEIRA.git
cd AnthropicEIRA
yarn install
```

Create a `.env` in the project root:

```env
ANTHROPIC_API_KEY=...
ORACLE_USERNAME=...
ORACLE_PASSWORD=...
ORACLE_CONNSTRING=localhost:1521/xepdb1
ORACLE_LIBRARY_DIR=C:\Path\to\instantclient
```

On Linux, point `ORACLE_LIBRARY_DIR` at the Instant Client folder the same way.

## Scripts

No npm scripts. Run the job with:

```bash
node index.js
```

Schedule that command however you like (Task Scheduler, cron, etc.).

## Layout

```text
index.js      DB select/insert, Claude prompt, main loop
logger.js     daily logs, success/error suffixes, zip + retention
package.json
yarn.lock
.env          local secrets (gitignored)
logs/         runtime logs (gitignored)
```

## License

MIT

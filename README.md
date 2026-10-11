# automate-daily-workflow

## Database setup

The application expects the PostgreSQL tables defined in `src/db/schema.ts`.
For a new database, set `DATABASE_URL` to the target PostgreSQL database, then
run this command from the project directory:

```sh
npm run db:push
```

This creates or updates the schema, including `app_config`, which stores email
recipients, holidays, and the automatic job schedule. Run it once for each
database/environment before starting the app. The command uses `DATABASE_URL`
from the environment or Next.js environment files (`.env`, `.env.local`, and
related files); verify that it points to the intended database before running
it. Take a database backup first if the database already contains data.

After updating to a release that adds database fields, run `npm run db:push`
against the intended database before restarting the app. The retry-count column
is added to `job_runs`; existing job rows default to zero retries.

After the schema is set up, start the app normally:

```sh
npm run start
```

## Production browser setup

The connectivity ASA preview and QAdmin email screenshot use Playwright Chromium.
After installing the npm dependencies, install the browser as the same Linux
user that runs the application:

```sh
npm run install:browser
```

Run this again when upgrading Playwright. On Linux hosts that report missing
shared libraries, install the browser's OS dependencies with
`npx playwright install --with-deps chromium` (this may require administrator
privileges), then restart the application.
ASA output is sent to Telegram as a sequence of compact JPEG pages, followed by
a separate approval message. This keeps image uploads small while retaining
the complete report; the full ASA output is also stored in connectivity results.

## Job retries and delivery outcomes

Preparation, QAdmin, and SMTP failures use a bounded retry policy with exponential
backoff and jitter (up to three retries). The retry count, next attempt time,
workflow step, and delivery outcome are stored in `job_runs`. Approved
preparation and delivery retries are recovered by the scheduler after an
application restart. Telegram approval still expires after ten minutes and
auto-approves on timeout; the persisted expiration is honored after a restart
without sending another preview.
Connectivity Excel updates are performed once before the SMTP retry loop; the
workbook replaces the sheet for a date, making a repeated date update
idempotent.

If SMTP fails while processing the DATA command, or the app stops during an
in-flight send, the server may have accepted the message even though the
application did not receive confirmation. Such a job is marked
`delivery_unknown` and is not automatically retried, to reduce the chance of
sending a duplicate. SMTP acceptance still does not prove inbox delivery.

The database schema now has workflow, retry, lease, and scheduled-run fields.
Run `npm run db:push` against the intended database before restarting after
upgrading. A unique index ensures at most one scheduled run per job
type and Dhaka calendar date, including when multiple app instances dispatch
the same schedule.

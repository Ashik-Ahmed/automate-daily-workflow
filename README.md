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

## Approved job delivery retries

After a roster or connectivity job is approved in Telegram, failures while
preparing or sending its email are retried immediately without asking for
approval again, with at most three retries (four attempts total) per job.
Connectivity QAdmin capture happens before the Telegram confirmation prompt
and shares that job's retry budget with email delivery. The job history retains
the most recent retry error while work is pending. Keep the app process running
while a retry is in progress. Failures before approval other than QAdmin
capture (for example, missing roster data) are not auto-retried.

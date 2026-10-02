# Self-hosting and updates

This guide targets a new, empty deployment. Do not overwrite an existing memory database or an index with different dimensions using new-install settings. Keep real resource IDs, secrets, and deployment results in owner-controlled storage.

## Prerequisites and separate configuration

You need Node 22 or later, npm, Git, Python 3, and a Cloudflare account. The deployment uses D1, KV, Vectorize, Workers AI, and SQLite-backed Durable Objects. Enable R2 if you want R2 backups. Protect the owner dashboard with Cloudflare Access. Each service has separate allowances and pricing; operation within free allowances is not guaranteed.

Deployment and build scripts explicitly fetch Wrangler 4.146.0. This is separate from the Wrangler version in package/lock files, which remain aligned with upstream. Do not replace the pinned deployment commands with unversioned calls such as `npx wrangler`.

```sh
npm ci --legacy-peer-deps
umask 077
cp wrangler.jsonc wrangler.personal.jsonc
chmod 600 wrangler.personal.jsonc
sb_cf_profile=your-profile
sb_worker_name=my-second-brain
npx --yes wrangler@4.146.0 login --profile "$sb_cf_profile"
npx --yes wrangler@4.146.0 whoami --profile "$sb_cf_profile" --json
```

Replace the profile and Worker names with your own values and verify that the account matches your deployment target. `.gitignore` protects `wrangler.personal.jsonc`. Set the Worker name and resource names below consistently in that file.

The shared configuration contains no real resource IDs. Wrangler can provision D1, KV, and other resources automatically, but this guide creates them first to make the target explicit and records your IDs in the deployment configuration. If you use automatic provisioning, deploy from a copy of the shared configuration and keep generated IDs out of public Git history.
[Wrangler automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning)

## Create empty resources

```sh
npx --yes wrangler@4.146.0 d1 create "${sb_worker_name}-db" --profile "$sb_cf_profile" --config wrangler.personal.jsonc
npx --yes wrangler@4.146.0 kv namespace create OAUTH_KV --profile "$sb_cf_profile" --config wrangler.personal.jsonc
npx --yes wrangler@4.146.0 vectorize create "${sb_worker_name}-eg128" --dimensions 128 --metric cosine --profile "$sb_cf_profile"
npx --yes wrangler@4.146.0 vectorize create-metadata-index "${sb_worker_name}-eg128" --property-name parentId --type string --profile "$sb_cf_profile"
npx --yes wrangler@4.146.0 vectorize create-metadata-index "${sb_worker_name}-eg128" --property-name workspace_id --type string --profile "$sb_cf_profile"
npx --yes wrangler@4.146.0 r2 bucket create "${sb_worker_name}-archive" --profile "$sb_cf_profile"
```

Record the returned IDs and actual names in `wrangler.personal.jsonc`.

| Setting | Your value |
| --- | --- |
| `name` | A unique Worker name |
| `d1_databases[0].database_name` / `database_id` | Name and ID of your D1 database |
| `kv_namespaces[0].id` | ID of your KV namespace |
| `vectorize[0].index_name` | Name of your 128-dimensional index |
| `r2_buckets[0].bucket_name` | Name of your private bucket |

Keep the binding names `DB`, `OAUTH_KV`, `VECTORIZE`, `AI`, `ARCHIVE`, and `MCP_EXECUTOR`. Retain the shared configuration's SQLite migration for `McpExecutor`, compatibility flags, asset routing, and five cron schedules. Leave both ChatGPT selection settings empty.

You can remove `r2_buckets` if you do not use R2. In that case, backup APIs return 503 and R2 recovery is unavailable. Create Vectorize metadata indexes before the first vector write. When adding them to an existing index, consult the [Team integration guide](../team-integration.md) to determine whether re-upsert is needed.

## Owner-only Cloudflare Access

In Cloudflare Zero Trust, set up your team domain, a policy allowing only the owner's email, and two self-hosted HTTP applications. Use the hostname where the Worker will be deployed.

| Application | Protected paths | Worker audience setting |
| --- | --- | --- |
| Dashboard | `/dashboard` and its descendants | `DASHBOARD_ACCESS_AUD` |
| Access-protected MCP | `/mcp` | `ACCESS_AUD` |

Obtain each application's Application Audience (AUD) tag. Set `ACCESS_TEAM_DOMAIN` to `https://YOUR-TEAM.cloudflareaccess.com` and `ACCESS_ALLOWED_EMAIL` to the owner's email. Configure the dashboard application so its API and HTML use the same audience.

Do not cover the entire hostname with a single Access application. `/oauth-mcp`, `/oauth/authorize`, `/oauth/token`, `/oauth/register`, and REST APIs use Worker authentication; their MCP OAuth challenge must not be replaced with a browser-facing Access page. The Worker also validates the dashboard JWT signature, issuer, audience, expiry, and owner email. Missing Access configuration makes the dashboard return 503 rather than exposing it.
[Access HTTP application configuration](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/)

## Configure secrets

Generate a random owner token and store it in a mode-0600 file outside Git. The following is for first-time setup and stops if an owner token already exists. Use separate storage locations for separate deployments. The token is not printed.

```sh
set -eu
umask 077
mkdir -p "$HOME/.config/second-brain-cf"
chmod 700 "$HOME/.config/second-brain-cf"
python3 - <<'PY_SECRET'
import getpass, json, os, secrets
from pathlib import Path
folder = Path.home() / '.config/second-brain-cf'
with (folder / 'owner-token').open('x') as token_file:
    token_file.write(secrets.token_urlsafe(32))
os.chmod(folder / 'owner-token', 0o600)
values = {'AUTH_TOKEN': (folder / 'owner-token').read_text().strip()}
for name in ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'DASHBOARD_ACCESS_AUD', 'ACCESS_ALLOWED_EMAIL']:
    values[name] = getpass.getpass(name + ': ').strip()
    if not values[name]: raise SystemExit('A configuration value is empty')
file = folder / 'secrets.json'
file.write_text(json.dumps(values))
os.chmod(file, 0o600)
PY_SECRET
npx --yes wrangler@4.146.0 secret bulk "$HOME/.config/second-brain-cf/secrets.json" --profile "$sb_cf_profile" --config wrangler.personal.jsonc
```

If prompted to create a Worker on first use, verify the configured Worker name and account. Secrets belong to this Worker. Do not put `AUTH_TOKEN` in URLs, shell arguments, public issues, or normal GitHub Actions logs.
[Wrangler secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

`CHATGPT_CREDENTIAL_KEY` is unnecessary when ChatGPT is not used. Do not add it to upstream's required secrets.

## Build, deploy, and initialize

```sh
npx --yes wrangler@4.146.0 deploy --dry-run --profile "$sb_cf_profile" --config wrangler.personal.jsonc
npx --yes wrangler@4.146.0 deploy --profile "$sb_cf_profile" --config wrangler.personal.jsonc
```

Check the deployed URL and call `/health` with the owner token. This example uses a curl configuration file so the token itself is not passed as an argument.

```sh
python3 - <<'PY_CURL'
import os
from pathlib import Path
folder = Path.home() / '.config/second-brain-cf'
token = (folder / 'owner-token').read_text().strip()
file = folder / 'curl-owner.conf'
file.write_text('header = "Authorization: Bearer ' + token + '"\n')
os.chmod(file, 0o600)
PY_CURL
sb_worker_url=https://YOUR-WORKER-URL
curl --fail --silent --show-error --config "$HOME/.config/second-brain-cf/curl-owner.conf" "$sb_worker_url/health"
```

Authenticated health waits for ordered runtime migrations before returning. Check `database.status=reachable`. Also inspect `ok` and the Vectorize/AI status separately. An empty database with no embeddings is valid; AI status is a passive observation. Database reachability alone does not establish search or generation quality.

Do not apply `db/schema.sql` directly to an existing remote database. `CREATE TABLE IF NOT EXISTS` alone cannot update the required columns and triggers.

Next, verify that unauthenticated REST requests are rejected, other email addresses cannot enter the dashboard, and the owner can. Use `/oauth-mcp` for OAuth MCP and `/mcp` for static-token MCP. Start by testing storage, search, and deletion with non-sensitive synthetic memories. Follow [SMOKE_MATRIX.md](SMOKE_MATRIX.md).

## Safeguards before updates and checks afterward

Explicitly select the configuration and profile used by the real deployment. The shared configuration leaves `CHATGPT_OPERATIONS` and `CHATGPT_OWNER_WORKSPACE_ID` empty; deploying it over an enabled installation disables direct generation. Explicit configuration values still apply with `--keep-vars`.

Before updating, record the current Worker version, D1 Time Travel recovery point, configuration, schema version, counts, and memory-content hashes for comparison in owner-controlled storage. Keep secrets and content out of public Git history.

A full SQL export may be unavailable for D1 databases containing FTS5 virtual tables. Combine Time Travel with SQL exports of only the required real tables. Exclude derived tables such as `entries_fts` and `entry_counts`, and ChatGPT tables `chatgpt_session` and `chatgpt_host`, from memory backups. After restoring to another Worker, authenticate again for that Worker's host. Reauthentication is also required if Time Travel rolls back a rotated refresh token.

After updating, check `/health`, schema, counts and hashes, authentication rejection, workspace isolation, and the required generation paths. Version rollback and D1 restore are separate operations. Confirm each operation's recovery target and the extent to which it rolls back updated memories.

## Optional ChatGPT connection

Use the owner-only procedure in [CHATGPT_DIRECT.md](CHATGPT_DIRECT.md). Record the suggested enablement settings shown after connection in `wrangler.personal.jsonc`, then deploy explicitly. Unselected operations continue to use Workers AI. Track ChatGPT usage separately from Cloudflare service usage.

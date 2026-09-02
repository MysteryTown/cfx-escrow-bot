# CFX Escrow Discord Bot

A Discord bot that automates FiveM/CFX escrow uploads for your development team.

## Features

- **Upload new assets**: Create and upload new escrowed resources
- **Update existing assets**: Re-upload to existing assets by ID or name
- **List assets**: View all your escrowed assets
- **Permission control**: Restrict usage to specific roles/channels
- **Slash commands**: Modern Discord UI with slash commands

## Commands

| Command | Description |
|---------|-------------|
| `/escrow` | Upload a .zip file to escrow (new or update) |
| `/escrow-list` | List all your escrowed assets |
| `/escrow-status` | Check connection to CFX Portal |

## Setup

### 1. Create a Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application" and give it a name
3. Go to "Bot" section and click "Add Bot"
4. Copy the **Token** (you'll need this)
5. Enable these Privileged Gateway Intents:
   - Message Content Intent
6. Go to "OAuth2" > "URL Generator"
   - Select scopes: `bot`, `applications.commands`
   - Select permissions: `Send Messages`, `Use Slash Commands`, `Attach Files`, `Embed Links`
7. Copy the generated URL and invite the bot to your server
8. Copy the **Application ID** from the "General Information" tab

### 2. Get Your CFX Forum Cookie

1. Go to [https://forum.cfx.re](https://forum.cfx.re) and log in
2. Open DevTools (F12 or right-click > Inspect)
3. Go to **Application** (Chrome) or **Storage** (Firefox) tab
4. Find **Cookies** > `forum.cfx.re`
5. Find the `_t` cookie and copy its value

> ⚠️ **Important**: After copying the cookie, clear it from your browser and log in again. This prevents the cookie from being invalidated when you log out.

### 3. Configure the Bot

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` with your values:
   ```env
   DISCORD_TOKEN=your_bot_token
   DISCORD_CLIENT_ID=your_application_id
   DISCORD_GUILD_ID=your_server_id  # Optional, for faster command registration
   CFX_FORUM_COOKIE=your_forum_t_cookie
   ```

### 4. Install & Run

```bash
# Install dependencies (this will also download Chromium for Puppeteer)
npm install

# Start the bot
npm start

# Or for development (auto-restart on changes)
npm run dev
```

> **Note**: First startup may take a minute as Puppeteer downloads Chromium. The bot uses a headless browser to handle CFX's SSO authentication flow.

## Usage

### Upload a New Asset

1. Use `/escrow` command
2. Attach your `.zip` file
3. Select "🆕 New Asset"
4. Enter the asset name

### Update an Existing Asset

1. Use `/escrow` command
2. Attach your `.zip` file
3. Select "🔄 Update Existing"
4. Enter the asset ID or name

### View Your Assets

Use `/escrow-list` to see all your escrowed assets with their IDs.

## Optional: Restrict Access

You can restrict who can use the bot by setting these in `.env`:

```env
# Only allow users with these roles (comma-separated role IDs)
ALLOWED_ROLES=123456789,987654321

# Only allow usage in these channels (comma-separated channel IDs)
ALLOWED_CHANNELS=123456789
```

## Cookie Refresh

The CFX forum cookie can expire due to inactivity. To keep it alive, you can:

1. Set up a cron job to run `/escrow-status` daily
2. Or manually use the bot at least once every few weeks

## Troubleshooting

### "Not connected to CFX Portal"
- Your forum cookie may have expired
- Get a fresh cookie from the forum
- Make sure you copied the entire `_t` cookie value

### "Asset not found"
- Double-check the asset ID or name
- Use `/escrow-list` to see your assets
- Asset names are case-insensitive

### Commands not showing
- Wait up to 1 hour for global commands to propagate
- Use `DISCORD_GUILD_ID` for instant updates in development

## Use as a GitHub Action

This repo also ships a **composite GitHub Action** so any of your FiveM source repos can auto-upload escrowed resources on push.

### How it works

A resource opts in to escrow by placing a `.escrow` marker file at its root, next to `fxmanifest.lua`:

| `.escrow` content | What happens |
|---|---|
| empty | Looks up an asset on CFX by the folder name. If found, re-uploads to it. If not, creates a new asset and writes the new ID into `.escrow`. |
| `12345` | Re-uploads to asset ID `12345`. |
| `{ "id": 12345, ... }` | JSON form. `id` field is used; other fields preserved on write-back. |

Before using a pinned ID, the uploader verifies that the CFX asset name matches the resource folder. A copied or mismatched ID falls back to the normal name lookup and updates the marker instead of overwriting another resource.

### Required secrets

- `CFX_FORUM_COOKIE` — the `_t` cookie from forum.cfx.re (see Setup → Step 2 above)
- `ESCROW_PAT` — a PAT (or fine-grained token) with **push** access to the source repo *and* to the `*-Escrowed` mirror repo

Set them at `https://github.com/<org>/<repo>/settings/secrets/actions` for each consuming repo.

> **Note**: Organization-level secrets for private repos require GitHub Team plan or higher. On the free plan, set these as repo-level secrets on each consuming repo. The workflow YAML doesn't change either way — `${{ secrets.X }}` resolves both.

### Minimal workflow for a consuming repo

`.github/workflows/escrow.yml`:

```yaml
name: escrow

on:
  push:
    branches: [main]

permissions:
  contents: write

jobs:
  escrow:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: ${{ secrets.ESCROW_PAT }}

      - uses: your-org/cfx-escrow-bot@v1
        with:
          forum-cookie:  ${{ secrets.CFX_FORUM_COOKIE }}
          resources-root: server-files/resources
          mirror-repo:   ${{ github.repository }}-Escrowed
          mirror-token:  ${{ secrets.ESCROW_PAT }}
```

The action will:

1. Diff `${{ github.event.before }}..HEAD` to find resource folders that changed.
2. Walk up from each changed file until it hits a `.escrow` marker → that resource is on the upload list.
3. Zip each resource folder (excluding `node_modules`, `.git`, `*.zip`).
4. Auth to CFX with the forum cookie (Puppeteer, headless Chromium).
5. Create-or-re-upload per the `.escrow` rules above.
6. Write asset IDs back into `.escrow` files and commit `chore(escrow): update asset ids [skip ci]`.

When CFX reports `MAX_VERSIONS_REACHED`, the uploader deletes the exhausted
asset, creates and uploads a replacement with the same resource name, and
writes the replacement ID to `.escrow`. If any requested upload fails,
mirroring is skipped so an older protected package cannot overwrite the
current source in the escrowed repository.
7. Force-push the resulting tree to `<repo>-Escrowed` so production servers can pull the unpacked escrowed version.

### Action inputs

| Input | Default | Purpose |
|---|---|---|
| `forum-cookie` | *(required)* | `_t` cookie value |
| `resources-root` | `.` | Subdirectory to scan |
| `changed-only` | `true` | `false` re-uploads every marked resource on every run |
| `base-ref` | `${{ github.event.before }}` | Override the diff base |
| `commit-back` | `true` | Commit updated `.escrow` files |
| `commit-message` | `chore(escrow): update asset ids [skip ci]` | |
| `mirror-repo` | *(empty)* | e.g. `your-org/your-repo-Escrowed`. Empty disables mirroring. |
| `mirror-token` | *(empty)* | PAT for the mirror push |
| `mirror-branch` | `main` | Branch to force-push to on the mirror |

### CLI usage (local / debugging)

```bash
# upload one folder
CFX_FORUM_COOKIE=... node src/cli-escrow.js --resource path/to/my_resource

# scan a tree
CFX_FORUM_COOKIE=... node src/cli-escrow.js --scan server-files/resources

# everything below cwd
CFX_FORUM_COOKIE=... node src/cli-escrow.js --all
```

## Credits

Based on the approach from [Tynopia/cfx-portal-upload](https://github.com/Tynopia/cfx-portal-upload).

## License

MIT

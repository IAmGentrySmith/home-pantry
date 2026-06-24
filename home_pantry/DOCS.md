# Home Pantry

Manage your kitchen/pantry inventory from Home Assistant: scan barcodes, track
expiration dates, sync a shopping list, and get notified before food goes bad.
Everything runs locally in this add-on.

> New here? The full step-by-step install and setup guide is in the
> [repository README](https://github.com/IAmGentrySmith/home-pantry). This page
> is the in-app reference for configuration and day-to-day use.

## Configuration

| Option | Description |
| --- | --- |
| `todo_list_entity_id` | Entity ID of the to-do list that consumed items are added to (e.g. `todo.pantry`). Find it under **Developer Tools > States**. Default: `todo.shopping_list`. |
| `llm_provider` | How expiration estimates are made. `none` = fixed 14-day default. `ai_task` and `ha_conversation` reuse an LLM you've configured in Home Assistant (no API key stored here). `openai`/`gemini` call those services directly. |
| `ai_task_entity_id` | Optional `ai_task.*` entity for the `ai_task` provider (**Settings > Voice assistants > AI Task**). Blank uses your preferred AI Task entity. |
| `ha_agent_id` | Optional conversation agent for `ha_conversation`. Blank uses your default agent. |
| `llm_api_key` | API key for `openai`/`gemini`. Stored as a secret. |
| `llm_model` | Model for `openai`/`gemini`, e.g. `gpt-4o-mini` or `gemini-1.5-flash`. Blank uses a per-provider default. |
| `api_token` | Optional bearer token for the Voice Assistant REST commands (see below). |
| `log_level` | `debug`, `info` (default), `warning`, or `error`. |

Options are read at start-up — **restart the add-on after changing them**.

## Using the app

Open the UI from the sidebar (or **Open Web UI** on the add-on page).

- **Scan** adds an item by camera barcode. Unknown barcodes prompt for a name and
  category. Allow camera access when asked (works over the HA UI / Companion App).
- **Edit** changes a product's name, category, and default shelf life
  (use `0` for non-perishable — no expiration is set).
- **Set Exp** picks an inventory item's expiration date (or clears it).
- **Merge** transfers this product's inventory onto another UPC and makes this
  barcode an alias of it (handy when the same product has two barcodes).
- **Consume** marks an item used **and** adds it to your shopping list.
- **Discard** marks an item used **without** touching the shopping list.

## Voice control (optional)

Voice assistants send text, not barcodes, so the add-on exposes fuzzy-matching
endpoints `POST /api/add_by_name` and `POST /api/consume_by_name`. Because a
`rest_command` calls the add-on directly (not via the authenticated ingress UI),
you must:

1. Set `api_token` to a long random string and **Save**.
2. In the add-on **Network** section, publish port `8099/tcp` and **Save**
   (it ships closed). **Restart** the add-on.
3. Add `rest_command`s in Home Assistant pointing at
   `http://<your-ha-host>:8099/...` with an `Authorization: Bearer <api_token>`
   header. See the README for a ready-to-paste example.

Direct API access without a valid token (or from anywhere other than ingress) is
rejected.

## Expiration sensor

The add-on maintains `sensor.pantry_expiring_items` — the count of items
expiring within 7 days — refreshed every 30 minutes. Because it is pushed via
the HA API, it is cleared on a Home Assistant restart and repopulates on the next
refresh. Build a Numeric State automation on it (Above: 0) to get notified.

## Data, backups & retention

The database is stored on the add-on's private `/data` volume and is included in
Home Assistant backups. Consumed items older than 90 days are purged
automatically. Uninstalling the add-on deletes `/data` (and the database), so
take a backup first if you want to keep your history.

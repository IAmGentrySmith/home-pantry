# Changelog

## 1.2.0

### Added
- `ai_task` expiration estimator that reuses a Home Assistant **AI Task** entity
  (`ai_task.generate_data`), so any LLM you've configured in HA — Anthropic/
  Claude (e.g. Haiku), OpenAI, Google, Ollama — can estimate shelf life with no
  API key stored in the add-on. New `ai_task_entity_id` option selects the
  entity (blank uses your preferred one).

### Changed
- Reworked the configuration page for clarity: provider-specific fields are
  grouped under the estimator and each notes which provider it applies to.
  `llm_model` is now optional and defaults to a per-provider model when blank.

## 1.1.0

### Added
- `homeassistant_api: true` so the to-do sync, expiring-items sensor, and the
  `ha_conversation` provider can reach the Home Assistant Core API.
- Token-protected direct API (`api_token` option) and an ingress-aware auth
  gate; the host port now ships closed by default.
- Public `/health` endpoint used by the container health check.
- Schema migration runner (`PRAGMA user_version`); audit timestamps
  (`created_at`, `consumed_at`); automatic purge of consumed items older than
  90 days.
- Outbound HTTP timeouts on all external calls; calendar-date and input-length
  validation; shared `helpers.js` now covered by unit tests.
- `translations/en.yaml`, `LICENSE`, CI workflow, and this changelog.

### Changed
- Repository restructured into the standard add-on layout (`repository.yaml` +
  `home_pantry/` subfolder) so the Add-on Store can install it.
- Database moved from `/share/home_pantry` to the private `/data` volume
  (one-time automatic migration from the old location); `share:rw` mapping
  removed.
- Builds limited to `aarch64`/`amd64` (32-bit architectures dropped).
- Expiring-sensor refresh shortened to 30 minutes.

### Fixed
- Non-perishable items (LLM returns `0`) no longer get a bogus 14-day expiry.
- Chained product merges are now atomic and no longer fail on a foreign-key
  constraint or leave partial state.
- `llm_used` is reported truthfully (false when no LLM call ran).
- Local-time date handling fixes an off-by-one near midnight.
- 500 responses no longer leak internal error details to the client.

## 1.0.0
- Initial release.

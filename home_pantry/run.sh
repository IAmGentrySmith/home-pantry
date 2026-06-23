#!/command/with-contenv bashio
set -e

bashio::log.info "Starting Home Pantry..."

# The database lives on the add-on's private, always-mapped /data volume
# (the app creates the file if needed), so no directory setup is required here.

cd /app
# exec so Node becomes PID 1 of this script and receives SIGTERM directly,
# allowing the graceful-shutdown handler in server.js to run on stop.
exec node server.js

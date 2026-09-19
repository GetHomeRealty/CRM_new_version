# O-1 - the health checks, installed on this server 2026-09-19.
#
# Copies of what is installed at /etc/systemd/system/, kept here because a unit file that exists
# only on one machine is lost the day that machine is rebuilt.
#
#   sudo cp scripts/systemd/ghr-monitor.* /etc/systemd/system/
#   sudo systemctl daemon-reload && sudo systemctl enable --now ghr-monitor.timer
#   journalctl -u ghr-monitor.service -n 20        # what it last reported
#   systemctl list-timers | grep ghr               # when it next runs
#
# ALERTING IS NOT CONFIGURED YET. It records to the journal and alerts nobody until
# ALERT_SMTP_HOST/ALERT_EMAIL_TO (or ALERT_WEBHOOK_URL) are set - awaiting an address from the
# brokerage. ALERT_HEARTBEAT_URL is the only part that survives this machine dying; set it too.

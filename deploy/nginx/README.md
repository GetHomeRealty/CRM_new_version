# Web server configuration — a copy, not the live file

The live files are at `/www/server/panel/vhost/nginx/` on the deploy host, outside this
repository. They carry the security headers, and nothing versioned them: a rebuild of the
server would lose that work silently, with no history to restore it from. Copied here on
2026-09-30 so there is a record.

THESE ARE COPIES. Editing them changes nothing. To change the live configuration, edit the
file on the host, take a `.bak` first, and copy the result back here in the same commit.

Certificate PATHS appear in these files. No key or password does.

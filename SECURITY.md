# Security policy

## Reporting a vulnerability

Report vulnerabilities **only** through GitHub private vulnerability reporting: open the
repository's Security tab and choose "Report a vulnerability", or go straight to
https://github.com/holetz/eclume/security/advisories/new.

Never open a public issue, pull request or discussion for a vulnerability. Include what is
affected, the steps to reproduce it and the impact you expect.

The only contact is Israel Holetz ([@holetz](https://github.com/holetz)), who receives the report
through the advisory. No email address is published. Reports are handled on a best-effort basis by
the maintainers listed in `GOVERNANCE.md`.

## Supported versions

The project has three version lines (see `docs/standards/code/versionamento.md`): the product
(server, GPU worker, engines and web), the desktop app and the phone app. While a line is 0.x,
only its latest release receives security fixes, with no backports.

| Version line | Supported |
| --- | --- |
| Product | latest release |
| Desktop app | latest release |
| Phone app | latest release |

## What to expect

You get an acknowledgement through the advisory, an assessment, and a fix released on the affected
line. The advisory is published once a fix is available.

# Security policy

This application takes payments, stores customer delivery information and controls a physical printer. Please do not publish exploit details, customer data or credentials in a GitHub issue.

If GitHub's **Report a vulnerability** option is available on the repository's Security tab, use it for a private report with the affected version, impact and reproduction steps. If it is unavailable, contact the repository owner privately through their GitHub profile and ask for a secure reporting channel; do not attach the exploit in a public message. Maintainers should enable GitHub private vulnerability reporting before making the repository public and publish a durable contact channel here.

For deployment boundaries, admin cookies, gateway authorization and recovery controls, see [admin security](docs/SECURITY.md). If a credential may have leaked, rotate it in the provider, revoke admin sessions, and review database, gateway and audit records. Do not assume deleting a commit removes a secret from history.

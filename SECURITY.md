# Security policy

## Report privately

Do not put vulnerabilities, access tokens, OAuth codes, private note contents, or working exploits in public issues or pull requests.

On the project's GitHub repository, use **Security → Advisories → Report a vulnerability** to open a private report through [GitHub private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability). This route requires the repository owner to enable GitHub private vulnerability reporting; it is a publication prerequisite, not something the source checkout enables. If the button is absent, open a public issue containing only “Please enable private vulnerability reporting” and wait for a private channel before sharing details. No monitored security email address is advertised.

Include the affected version or commit, a synthetic reproduction, expected and actual behavior, impact, and suggested mitigation if available. Remove credentials, personal data, account identifiers, and private repository URLs. Agree on disclosure timing with the maintainer before publication. No response-time SLA or bug bounty is offered.

## Supported scope

Security fixes target the current source revision. Older snapshots have no maintenance commitment. This is pre-release software: local tests and a dry-run build do not constitute a penetration test or a live deployment audit.

Areas of particular concern include OAuth consent and token handling, identity and scope bypass, path restrictions, stale writes, untrusted content, and accidental exposure of private data. The server processes plaintext and trusts write-enabled clients to submit user-selected data; it cannot validate the truth of a claim or a client's selection process.

## If your installation is exposed

Stop the Worker and its routes, revoke exposed GitHub credentials, and invalidate OwnContext OAuth grants before restoring service. Correcting a note or rotating an App secret does not erase Git history or revoke all client grants. Follow [recovery and uninstall](docs/en/recovery-and-uninstall.md).

Keep dependencies updated, restrict the repository token to one private repository, and retain only data you intend to share with connected clients. Run `npm run check:release` before publishing source, but also inspect the diff and Git history manually: pattern scanning is not proof that data is safe to publish.

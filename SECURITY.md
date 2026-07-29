# Security Policy

## Supported versions

Worklog is under active development. Security fixes are applied to the latest version on the `main` branch until tagged releases begin.

## Reporting a vulnerability

Please do not open a public issue for vulnerabilities involving credential exposure, local file access, command execution, meeting audio, transcript leakage, authentication, or unintended remote data transfer.

Use the repository's **Security → Report a vulnerability** flow to submit a private GitHub Security Advisory. Include:

- affected version or commit;
- reproduction steps using synthetic data;
- expected and actual behavior;
- potential impact;
- any suggested remediation.

Avoid attaching real API keys, work logs, meeting recordings, customer data, or proprietary code. Maintainers aim to provide an initial response within seven days.

## Security boundaries

Worklog processes sensitive local work context. The web interface listens only on `127.0.0.1`. LLM credentials are stored in macOS Keychain. Raw meeting audio remains local. Filtered text is sent only to the LLM and publishing destinations configured by the user.

See [PRIVACY.md](PRIVACY.md) for the complete data flow and user controls.
